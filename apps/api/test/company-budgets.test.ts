import { describe, it, expect } from 'vitest';
import { makeApp, TODAY_LOCAL, asOwner, expectDbError, addMember } from './helpers';
import { x2Kit } from './x2-helpers';
import { maxReportRows, setReportRowLimit } from '../src/http/limits';
describe('şirket ve departman bütçeleri', async () => {
  const { app } = await makeApp(),
    kit = x2Kit(app);
  async function setup(name: string) {
    const w = await kit.setup(name, { sector: 'CONSTRUCTION' });
    const config = {
      title: 'Yıllık saha planı',
      year: Number(TODAY_LOCAL.slice(0, 4)),
      scope: 'company',
      lines: [
        { accountId: w.ids['632'], kind: 'expense', amounts: Array(12).fill('100.00') },
        { accountId: w.ids['600'], kind: 'revenue', amounts: Array(12).fill('200.00') },
      ],
    };
    const created = await w.c.post('/api/company-budgets', config);
    expect(created.statusCode, created.body).toBe(201);
    return { ...w, config, budget: created.json().budget, month: Number(TODAY_LOCAL.slice(5, 7)) };
  }
  async function journal(w: Awaited<ReturnType<typeof setup>>, amount: string, projectId?: string) {
    const r = await w.c.post('/api/journal-entries', {
      entryDate: TODAY_LOCAL,
      description: 'Bütçe gideri',
      lines: [
        { accountId: w.ids['632'], debit: amount, credit: '0', currency: 'TRY', projectId },
        { accountId: w.ids['100'], debit: '0', credit: amount, currency: 'TRY' },
      ],
      post: false,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().entry;
  }
  it('taslak hariç, kayıtlı ve ters kayıt dahil; onaylı revizyon değişmez ve yeni revizyon onayı geçmişi korur', async () => {
    const w = await setup('Budget'),
      entry = await journal(w, '110.01');
    const draft = (await w.c.get(`/api/company-budgets/${w.budget.id}`)).json();
    expect(draft.lines[0].months[w.month - 1]).toMatchObject({ actual: '0.00', planned: '100.00' });
    expect((await w.c.post(`/api/journal-entries/${entry.id}/post`)).statusCode).toBe(200);
    const posted = (await w.c.get(`/api/company-budgets/${w.budget.id}`)).json();
    expect(posted.lines[0].months[w.month - 1]).toMatchObject({
      actual: '110.01',
      variance: '10.01',
      favorable: false,
    });
    expect(posted.totals.net.actual).toBe('-110.01');
    const rowLimit = maxReportRows();
    try {
      setReportRowLimit(1);
      const oversized = await w.c.get(`/api/company-budgets/${w.budget.id}`);
      expect(oversized.statusCode).toBe(422);
      expect(oversized.json().error.code).toBe('REPORT_TOO_LARGE');
    } finally {
      setReportRowLimit(rowLimit);
    }
    let acquired = 0;
    try {
      while (app.exportGate.tryAcquire()) acquired++;
      const busy = await w.c.get(`/api/company-budgets/${w.budget.id}/export?format=csv`);
      expect(busy.statusCode).toBe(429);
    } finally {
      for (let i = 0; i < acquired; i++) app.exportGate.release();
    }
    const csv = await w.c.get(`/api/company-budgets/${w.budget.id}/export?format=csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain('110,01');
    expect(csv.headers['content-disposition']).toContain('.csv');
    const xlsx = await w.c.get(`/api/company-budgets/${w.budget.id}/export?format=xlsx`);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const source = (
      await w.c.get(
        `/api/company-budgets/${w.budget.id}/transactions?accountId=${w.ids['632']}&month=${w.month}`,
      )
    ).json();
    expect(source.items[0].entryId).toBe(entry.id);
    expect(
      (await w.c.post(`/api/company-budgets/${w.budget.id}/approve`, { version: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await w.c.put(`/api/company-budgets/${w.budget.id}`, { config: w.config, version: 2 }))
        .statusCode,
    ).toBe(409);
    await asOwner(async (q) =>
      expect(
        (
          await expectDbError(
            q,
            "update company_budgets set config=jsonb_set(config,'{title}','\"hata\"'),version=version+1 where id=$1",
            [w.budget.id],
          )
        ).code,
      ).toBe('ERP19'),
    );
    const revisions = await Promise.all([
      w.c.post(`/api/company-budgets/${w.budget.id}/revise`),
      w.c.post(`/api/company-budgets/${w.budget.id}/revise`),
    ]);
    expect(revisions.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const revision = revisions.find((r) => r.statusCode === 201)!.json().budget;
    const config = {
      ...w.config,
      lines: w.config.lines.map((l) => ({ ...l, amounts: Array(12).fill('150') })),
    };
    expect(
      (await w.c.put(`/api/company-budgets/${revision.id}`, { config, version: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await w.c.put(`/api/company-budgets/${revision.id}`, { config, version: 1 })).statusCode,
    ).toBe(409);
    expect(
      (await w.c.post(`/api/company-budgets/${revision.id}/approve`, { version: 2 })).statusCode,
    ).toBe(200);
    expect((await w.c.get(`/api/company-budgets/${w.budget.id}`)).json().budget.status).toBe(
      'superseded',
    );
    expect(
      (await w.c.get(`/api/company-budgets/${w.budget.id}`)).json().lines[0].total.planned,
    ).toBe('1200.00');
    const reversed = await w.c.post(`/api/journal-entries/${entry.id}/reverse`, {
      entryDate: TODAY_LOCAL,
      reason: 'Yanlış gider düzeltme',
    });
    expect(reversed.statusCode, reversed.body).toBe(201);
    expect(
      (await w.c.get(`/api/company-budgets/${revision.id}`)).json().lines[0].total.actual,
    ).toBe('0.00');
    await asOwner(async (q) =>
      expect(
        (await expectDbError(q, 'delete from company_budgets where id=$1', [w.budget.id])).code,
      ).toBe('ERP19'),
    );
  });
  it('departman proje süzgeci, şirket izolasyonu, okuyucu ve onay yetkisi', async () => {
    const w = await setup('Department');
    const project = (
      await w.c.post('/api/projects', { code: 'DEP-1', name: 'Departman projesi', kind: 'own' })
    ).json().project;
    expect(project).toBeTruthy();
    const first = await journal(w, '50', project.id),
      second = await journal(w, '80');
    await w.c.post(`/api/journal-entries/${first.id}/post`);
    await w.c.post(`/api/journal-entries/${second.id}/post`);
    const r = await w.c.post('/api/company-budgets', {
      ...w.config,
      scope: 'department',
      department: 'Şantiye',
      projectIds: [project.id],
    });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json().budget;
    const report = (await w.c.get(`/api/company-budgets/${b.id}`)).json();
    expect(report.totals.expense.actual).toBe('50.00');
    expect(report.coverage).toMatchObject({
      departmentMethod: 'projects',
      projectNames: ['Departman projesi'],
    });
    expect(
      (await w.c.get(`/api/company-budgets/${w.budget.id}`)).json().totals.expense.actual,
    ).toBe('130.00');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer', 'Budgetviewer');
    expect((await viewer.client.get(`/api/company-budgets/${b.id}`)).statusCode).toBe(200);
    expect((await viewer.client.post('/api/company-budgets', w.config)).statusCode).toBe(403);
    const accountant = await addMember(app, w.c, w.company.id, 'accountant', 'Budgetaccountant');
    expect(
      (await accountant.client.post(`/api/company-budgets/${b.id}/approve`, { version: 1 }))
        .statusCode,
    ).toBe(403);
    const other = await kit.setup('Otherbudget');
    expect((await other.c.get(`/api/company-budgets/${b.id}`)).statusCode).toBe(404);
    const foreign = await other.c.post('/api/company-budgets', { ...w.config });
    expect(foreign.statusCode).toBe(400);
    expect(
      (
        await w.c.put(`/api/company/members/${viewer.userId}/module-access`, {
          levels: { 'construction.projects': 'none' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await viewer.client.get(`/api/company-budgets/${b.id}`)).statusCode).toBe(403);
    expect(
      (await viewer.client.get('/api/company-budgets')).json().items.map((r: any) => r.id),
    ).not.toContain(b.id);
    expect(
      (await viewer.client.get(`/api/company-budgets/${b.id}/export?format=csv`)).statusCode,
    ).toBe(403);
    const admin = await addMember(app, w.c, w.company.id, 'admin', 'Budgetadmin');
    expect(
      (
        await w.c.put(`/api/company/members/${admin.userId}/module-access`, {
          levels: { 'construction.projects': 'none' },
        })
      ).statusCode,
    ).toBe(200);
    const audit = (
      await admin.client.get(
        `/api/reports/activity?from=${TODAY_LOCAL}&to=${TODAY_LOCAL}&table=company_budgets`,
      )
    ).json();
    expect(audit.events.map((e: any) => e.rowId)).not.toContain(b.id);
    expect(audit.events.map((e: any) => e.rowId)).toContain(w.budget.id);
    const scopedSources = (
      await admin.client.get(
        `/api/company-budgets/${w.budget.id}/transactions?accountId=${w.ids['632']}&month=${w.month}`,
      )
    ).json();
    expect(scopedSources.items).toHaveLength(2);
    expect(scopedSources.items.every((r: any) => r.projectName === null)).toBe(true);
  });
});
