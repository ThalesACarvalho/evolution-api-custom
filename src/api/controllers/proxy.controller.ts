import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDto } from '@api/dto/proxy.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ProxyService } from '@api/services/proxy.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { makeProxyAgent } from '@utils/makeProxyAgent';
import axios from 'axios';

const logger = new Logger('ProxyController');

export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly waMonitor: WAMonitoringService,
  ) {}

  public async createProxy(instance: InstanceDto, data: ProxyDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    if (!data?.enabled) {
      data.host = '';
      data.port = '';
      data.protocol = '';
      data.username = '';
      data.password = '';
    }

    if (data.host) {
      const testResult = await this.testProxy(data);
      if (!testResult.success) {
        throw new BadRequestException(
          `[${testResult.code}] ${testResult.reason} (Server IP: ${testResult.serverIp}, Proxy IP: ${testResult.proxyIp})`
        );
      }
    }

    return this.proxyService.create(instance, data);
  }

  public async findProxy(instance: InstanceDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    return this.proxyService.find(instance);
  }

  public async testProxy(proxy: ProxyDto) {
    const result = {
      success: false,
      code: '',
      reason: '',
      serverIp: '',
      proxyIp: '',
    };

    try {
      // 1. IP do servidor sem proxy
      const serverIpResponse = await axios.get('https://icanhazip.com/');
      result.serverIp = serverIpResponse.data.trim();

      // 2. IP via proxy
      const proxyResponse = await axios.get('https://icanhazip.com/', {
        httpsAgent: makeProxyAgent(proxy),
        timeout: 5000,
      });
      result.proxyIp = proxyResponse.data.trim();

      // 3. Comparação
      if (result.serverIp !== result.proxyIp) {
        result.success = true;
        result.code = 'ok1';
        result.reason = 'Proxy is working. IP changed successfully.';
      } else {
        result.code = 'error1';
        result.reason = 'Proxy connected, but IP did not change (transparent proxy?).';
      }

      return result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          result.code = 'error2';
          result.reason = 'Connection refused (proxy offline or wrong host/port).';
        } else if (error.code === 'ETIMEDOUT') {
          result.code = 'error3';
          result.reason = 'Connection timed out (proxy too slow or blocked).';
        } else if (error.response?.status === 407) {
          result.code = 'error4';
          result.reason = 'Proxy authentication failed (wrong user/pass).';
        } else {
          result.code = 'error5';
          result.reason = `Axios error: ${error.message}`;
        }
      } else {
        result.code = 'error6';
        result.reason = `Unknown error: ${String(error)}`;
      }

      logger.error(`testProxy failed [${result.code}]: ${result.reason}`);
      return result;
    }
  }
}
