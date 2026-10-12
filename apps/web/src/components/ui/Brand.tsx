import markLight from '../../../public/logo-mark.webp';
import markDark from '../../../public/logo-mark-on-dark.webp';
import { cn } from '../../lib/cn';

/** Product identity shared by both apps; tenant document branding remains separate. */
export function Brand({ mark = false, onDark = false, className }: { mark?: boolean; onDark?: boolean; className?: string }) {
  return <span role="img" aria-label="Ada ERP" className={cn('inline-flex h-8 w-fit shrink-0 select-none items-center gap-2.5', onDark ? 'text-on-inverted' : 'text-text', className)}>
    {onDark ? <img src={markDark} alt="" draggable={false} width={256} height={192} className="h-full w-auto object-contain" /> : <>
      <img src={markLight} alt="" draggable={false} width={256} height={192} className="h-full w-auto object-contain dark:hidden" />
      <img src={markDark} alt="" draggable={false} width={256} height={192} className="hidden h-full w-auto object-contain dark:block" />
    </>}
    {!mark && <span className="whitespace-nowrap text-[1.05rem] font-semibold tracking-tight">Ada <span className="font-medium">ERP</span></span>}
  </span>;
}
