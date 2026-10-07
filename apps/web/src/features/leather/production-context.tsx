import { Link, useLocation, type LinkProps } from 'react-router-dom';
import { useCan, useCQuery } from '../../lib/queries';
import type { Permission } from '@erp/shared';

export function productionPath(path:string,generic:boolean){
  if(!generic)return path;
  if(path.startsWith('/api/leather'))return path.replace('/api/leather','/api/manufacturing');
  return path.replace('/leather/models','/manufacturing/catalog').replace('/leather/subcontracts','/manufacturing/subcontracting').replace('/leather/production','/manufacturing/production').replace('/leather/quality','/manufacturing/quality').replace('/leather','/manufacturing');
}
export function useGenericProduction(){return useLocation().pathname.startsWith('/manufacturing');}
export function useProductionCan(){const generic=useGenericProduction(),can=useCan();return (p:string)=>can((generic?p.replace('leather.','manufacturing.'):p)as Permission);}
export function useProductionQuery<T>(key:Parameters<typeof useCQuery>[0],path:string|null,options?:Parameters<typeof useCQuery>[2]){const generic=useGenericProduction();return useCQuery<T>(key,path===null?null:productionPath(path,generic),options);}
export function ProductionLink(props:LinkProps){const generic=useGenericProduction();return <Link {...props} to={typeof props.to==='string'?productionPath(props.to,generic):props.to}/>;}
