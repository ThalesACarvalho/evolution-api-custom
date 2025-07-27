export class MonitorProxyIpService {
  private monitoredInstances: Set<string> = new Set();

  public addInstance(instanceName: string) {
    this.monitoredInstances.add(instanceName);
    return Array.from(this.monitoredInstances);
  }

  public removeInstance(instanceName: string) {
    this.monitoredInstances.delete(instanceName);
    return Array.from(this.monitoredInstances);
  }

  public listInstances() {
    return Array.from(this.monitoredInstances);
  }

  public isMonitored(instanceName: string) {
    return this.monitoredInstances.has(instanceName);
  }
}

export const monitorProxyIpService = new MonitorProxyIpService();
