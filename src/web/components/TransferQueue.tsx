import { TransferCenter, type TransferCenterProps } from './TransferCenter';

/** Compatibility wrapper for existing consumers; new flows use TransferCenter directly. */
export interface TransferQueueProps extends TransferCenterProps {}

export const TransferQueue = (props: TransferQueueProps) => (
  <TransferCenter {...props} ariaLabel="文件传输队列" includeJobIdInActionLabel={false} />
);
