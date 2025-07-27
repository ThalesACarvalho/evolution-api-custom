import { RouterBroker } from '@api/abstract/abstract.router';
import { monitorProxyIpService } from '@api/services/monitorProxyIp.service';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class MonitorRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();

    this.router
      /**
       * ✅ Ativar ou desativar monitoramento de IP para uma instância
       */
      .post('/monitor-proxy-ip', ...guards, async (req, res) => {
        const { instanceName, action } = req.body;

        if (!instanceName || !['add', 'remove'].includes(action)) {
          return res
            .status(HttpStatus.BAD_REQUEST)
            .json({ error: 'instanceName and action (add/remove) are required' });
        }

        const list =
          action === 'add'
            ? monitorProxyIpService.addInstance(instanceName)
            : monitorProxyIpService.removeInstance(instanceName);

        return res.status(HttpStatus.OK).json({ monitoredInstances: list });
      })

      /**
       * ✅ Listar instâncias monitoradas
       */
      .get('/monitor-proxy-ip', ...guards, async (_req, res) => {
        return res
          .status(HttpStatus.OK)
          .json({ monitoredInstances: monitorProxyIpService.listInstances() });
      });
  }

  public readonly router: Router = Router();
}
