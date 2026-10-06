import { describe,it,expect } from 'vitest';
import { unzipSync,strFromU8 } from 'fflate';
import { writeXlsx,writeXlsxStream } from '../src/files/xlsx-write';
import type { ReportTable } from '../src/files/table';
describe('Akışlı XLSX yazıcı',()=>{
  it('stil, sayı, tarih, filtre, toplam ve formül güvenliği eski dosya ile aynı kalır',async()=>{
    const tables:ReportTable[]=[{key:'sheet',title:'Şantiye / maliyet',subtitle:'Dönem',columns:[{key:'text',label:'Açıklama',kind:'text'},{key:'amount',label:'Tutar',kind:'money',currency:'GBP'},{key:'date',label:'Tarih',kind:'date'}],rows:[{text:'=HYPERLINK("file") & <test>',amount:'123.45',date:'2026-10-06'},{text:'Test',amount:'-10',date:'eksik'}],totals:{amount:'113.45'}},{key:'sheet',title:'Şantiye / maliyet',plain:true,columns:[{key:'n',label:'Adet',kind:'int'}],rows:[{n:2}]}];
    const parts:Buffer[]=[];for await(const data of writeXlsxStream(tables))parts.push(data);
    const streamed=unzipSync(Buffer.concat(parts)),original=unzipSync(writeXlsx(tables));
    expect(Object.keys(streamed).sort()).toEqual(Object.keys(original).sort());
    for(const name of Object.keys(original))expect(strFromU8(streamed[name]!)).toBe(strFromU8(original[name]!));
    expect(strFromU8(streamed['xl/worksheets/sheet1.xml']!)).not.toContain('<f>');
  });
  it('100.000 satırda tüketici durduğunda satır üretimi durur ve iptal temizlenir',async()=>{
    let reads=0;
    const rows=Array.from({length:100000},(_,i)=>({get text(){reads++;return `Kalem ${i} — ${i*123457} — şantiye açıklaması`;}}));
    const stream=writeXlsxStream([{key:'large',title:'Büyük rapor',plain:true,columns:[{key:'text',label:'Açıklama',kind:'text'}],rows}]);
    const iterator=stream[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise(resolve=>setTimeout(resolve,30));
    expect(reads).toBeLessThan(100000);
    const before=reads;await new Promise(resolve=>setTimeout(resolve,30));expect(reads).toBe(before);
    await iterator.return?.();expect(stream.destroyed).toBe(true);
    const full=writeXlsxStream([{key:'large',title:'Büyük rapor',plain:true,columns:[{key:'text',label:'Açıklama',kind:'text'}],rows}]);
    const parts:Buffer[]=[];for await(const data of full)parts.push(data);
    const sheet=strFromU8(unzipSync(Buffer.concat(parts))['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('r="100001"');expect((sheet.match(/<row /g)??[]).length).toBe(100001);
  });
});

