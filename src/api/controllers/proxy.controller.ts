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

      // ✅ Aceita o proxy se for válido OU se o único problema for SSL (error8)
      if (!testResult.success && testResult.code !== 'error8') {
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

    const testUrls = {
      http: 'http://api.ipify.org',
      https: 'https://api.ipify.org',
    };

    try {
      // 1. IP do servidor sem proxy
      const serverIpResponse = await axios.get(testUrls.http, { timeout: 5000 });
      result.serverIp = serverIpResponse.data.trim();

      // 2. Testa via HTTP (menos bloqueios)
      try {
        const proxyResponse = await axios.get(testUrls.http, {
          httpAgent: makeProxyAgent({ ...proxy, protocol: 'http' }),
          timeout: 7000,
        });
        result.proxyIp = proxyResponse.data.trim();
      } catch (httpError) {
        // 3. Fallback via HTTPS (aceita SSL inseguro)
        try {
          const httpsResponse = await axios.get(testUrls.https, {
            httpsAgent: makeProxyAgent({ ...proxy, protocol: 'https' }),
            timeout: 7000,
          });
          result.proxyIp = httpsResponse.data.trim();
        } catch (httpsError) {
          if (
            axios.isAxiosError(httpsError) &&
            httpsError.message.toLowerCase().includes('self signed')
          ) {
            result.code = 'error8';
            result.reason =
              'SSL certificate issue (self-signed or untrusted). Proxy accepted due to allowed SSL exception.';
            result.success = true; // ✅ Considera válido mesmo com problema de SSL
            return result;
          } else {
            throw httpsError;
          }
        }
      }

      // 4. Verifica se obteve um proxyIp válido
      if (!result.proxyIp) {
        if (!result.code) {
          result.code = 'error5';
          result.reason = 'Proxy did not return any valid IP.';
        }
        return result;
      }

      // 5. Compara IPs
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
        } else if (error.response?.status === 403) {
          result.code = 'error7';
          result.reason = 'Access forbidden (proxy blocked or wrong credentials).';
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
