import { Injectable } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Injectable()
export class ClientService {
  constructor(private readonly devDataService: DevDataService) {}

  getBootstrap(token?: string) {
    return this.devDataService.getBootstrap(token);
  }

  getSubscription(token?: string) {
    return this.devDataService.getSubscription(token);
  }

  getNodes(token?: string) {
    return this.devDataService.getNodes(token);
  }

  getPolicies() {
    return this.devDataService.getPolicies();
  }

  getVersion(token?: string) {
    return this.devDataService.getBootstrap(token).then((result) => result.version);
  }

  connect(nodeId: string, mode: "global" | "rule" | "direct", strategyGroupId?: string, token?: string) {
    return this.devDataService.connect({ nodeId, mode, strategyGroupId }, token);
  }

  heartbeat(sessionId: string, token?: string) {
    return this.devDataService.heartbeatSession(sessionId, token);
  }

  disconnect(sessionId: string, token?: string) {
    return this.devDataService.disconnect(sessionId, token);
  }

  getRuntime() {
    return this.devDataService.getActiveRuntime();
  }
}
