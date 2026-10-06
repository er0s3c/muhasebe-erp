import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { MemoryLimiter } from './limits';

type MaybeAsync<T>=T|Promise<T>;
export interface RateLimiter {
  consume(key:string,max:number,windowMs:number):MaybeAsync<{ok:boolean;retryAfterSec:number}>;
  blocked(key:string,max:number):MaybeAsync<number>;
  hit(key:string,windowMs:number):MaybeAsync<void>;
  reset(key:string):MaybeAsync<void>;
}
type Counter={current:number;ttl:number};
export class PostgresLimiter implements RateLimiter {
  constructor(private db:Db,private enabled=true) {}
  async step(key:string,max:number,windowMs:number,mode:'consume'|'blocked'|'reset'):Promise<Counter>{
    if(!this.enabled)return {current:0,ttl:0};
    const digest=createHash('sha256').update(key).digest('hex');
    const row=(await this.db.execute<Counter>(sql`select current,ttl from rate_limit_step(${digest},${max}::int,${windowMs}::int,${mode})`)).rows[0];
    if(!row)throw new Error('Paylaşılan oran sınırı okunamadı.');
    return row;
  }
  async consume(key:string,max:number,windowMs:number){const r=await this.step(key,max,windowMs,'consume');return {ok:r.current<=max,retryAfterSec:r.current>max?Math.max(1,Math.ceil(r.ttl/1000)):0};}
  async blocked(key:string,max:number){const r=await this.step(key,max,1,'blocked');return r.current>=max?Math.max(1,Math.ceil(r.ttl/1000)):0;}
  async hit(key:string,windowMs:number){await this.step(key,1000000,windowMs,'consume');}
  async reset(key:string){await this.step(key,1,1,'reset');}
}
// Route-local fastify buckets must also share the same deterministic namespace across processes.
export function postgresFastifyStore(db:Db){
  return class Store {
    private limiter=new PostgresLimiter(db);
    constructor(private prefix='fastify'){}
    incr(key:string,callback:(error:Error|null,result?:Counter)=>void,timeWindow:number,max:number){
      void this.limiter.step(`${this.prefix}:${key}`,max,timeWindow,'consume').then(r=>callback(null,r),e=>callback(e instanceof Error?e:new Error('Oran sınırı deposu hatası.')));
    }
    child(route:{method?:unknown;path?:string;prefix?:string}){return new Store(`${this.prefix}:${String(route.method??'')}:${route.prefix??''}:${route.path??''}`);}
  };
}
export type CompatibleLimiter=MemoryLimiter|PostgresLimiter;
