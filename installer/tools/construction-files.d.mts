export function backupFiles(root:string,archive:string):Promise<{count:number}>;
export function restoreFiles(root:string,archive:string):Promise<{count:number}>;
