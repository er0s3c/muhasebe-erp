const costKeys=new Set(['wipValue','wip_value','provisionalValue','provisional_value','currentValue','current_value','value','cost','partsCost','journalEntryId','journal_entry_id','provisionalUnitCost','settledProvisional','settled_provisional']);
const traceKeys=new Set(['trace','destinations','rootId','root_id','sourceJournalLineId','source_journal_line_id']);
export { costKeys as LEATHER_CONFIDENTIAL_COST_KEYS, traceKeys as LEATHER_CONFIDENTIAL_TRACE_KEYS };
/** Applied before domain responses, workspace detail and exports leave the tenant transaction. */
export function redactLeatherCosts(value:unknown):unknown{
 if(Array.isArray(value))return value.map(redactLeatherCosts);
 if(value&&typeof value==='object'&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).filter(([key])=>!traceKeys.has(key)).map(([key,v])=>[key,costKeys.has(key)?null:redactLeatherCosts(v)]));
 return value;
}
