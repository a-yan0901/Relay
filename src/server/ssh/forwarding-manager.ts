export interface PortForwardRequest {
  hostId: string;
  bindAddress: string;
  bindPort: number;
  targetAddress: string;
  targetPort: number;
}

export interface PortForwardHandle {
  id: string;
  close(): Promise<void>;
}

/** Reserved for a separately approved browser-access and bind-security design. */
export interface ForwardingManager {
  open(request: PortForwardRequest): Promise<PortForwardHandle>;
  close(forwardId: string): Promise<void>;
}
