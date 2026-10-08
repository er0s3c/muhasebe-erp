const fs = require('fs');

let content = fs.readFileSync('apps/api/src/modules/leather/production.ts', 'utf-8');

content = content.replace(
    /where o\.id in \(\$\{sql\.join\(ids\.map\(\(id\) => sql`\$\{id\}::uuid`\), sql`, `\)\}\)/g,
    "where o.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})"
);

content = content.replace(
    /where r\.order_id in \(\$\{sql\.join\(ids\.map\(\(id\) => sql`\$\{id\}::uuid`\), sql`, `\)\}\)/g,
    "where r.order_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})"
);

fs.writeFileSync('apps/api/src/modules/leather/production.ts', content);
