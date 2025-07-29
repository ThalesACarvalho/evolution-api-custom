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

    let testResult = {
      success: false,
      code: '',
      reason: '',
      serverIp: '',
      proxyIp: '',
    };

    if (!data?.enabled) {
      data.host = '';
      data.port = '';
      data.protocol = '';
      data.username = '';
      data.password = '';
    }

    if (data.host) {
      testResult = await this.testProxy(data);

      // ✅ Só rejeita se não for sucesso nem caso especial aceito
      if (!testResult.success && testResult.code !== 'error8' && testResult.code !== 'ok2') {
        throw new BadRequestException(
          `[${testResult.code}] ${testResult.reason} (Server IP: ${testResult.serverIp}, Proxy IP: ${testResult.proxyIp})`,
        );
      }

      logger.log(
        `Proxy test passed [${testResult.code}]: ${testResult.reason} (Server IP: ${testResult.serverIp}, Proxy IP: ${testResult.proxyIp})`,
      );
    }

    // ✅ Retorna também os detalhes do teste no JSON
    return {
      ...this.proxyService.create(instance, data),
      testResult,
    };
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

      // 2. Testa via HTTP primeiro
      try {
        const proxyResponse = await axios.get(testUrls.http, {
          httpAgent: makeProxyAgent({ ...proxy, protocol: 'http' }),
          timeout: 7000,
        });
        result.proxyIp = proxyResponse.data.trim();
      } catch (httpError) {
        // 3. Fallback via HTTPS
        try {
          const httpsResponse = await axios.get(testUrls.https, {
            httpsAgent: makeProxyAgent({ ...proxy, protocol: 'https' }),
            timeout: 7000,
          });
          result.proxyIp = httpsResponse.data.trim();
        } catch (httpsError) {
          if (axios.isAxiosError(httpsError) && httpsError.message.toLowerCase().includes('self signed')) {
            result.code = 'error8';
            result.reason = `SSL certificate issue (self-signed or untrusted). Proxy accepted. (Server IP: ${result.serverIp}, Proxy IP: unknown)`;
            result.success = true;
            return result;
          } else if (
            axios.isAxiosError(httpsError) &&
            httpsError.response?.status === 502 &&
            httpsError.response?.headers['x-brd-error']?.includes('no_peer')
          ) {
            result.code = 'ok2';
            result.reason = `Proxy connected but no peers available for this city. (Server IP: ${result.serverIp}, Proxy IP: unknown)`;
            result.success = true;
            return result;
          } else {
            throw httpsError;
          }
        }
      }

      // 4. Caso não tenha retornado proxyIp
      if (!result.proxyIp) {
        result.proxyIp = 'unknown';
        if (!result.code) {
          result.code = 'error5';
          result.reason = `Proxy did not return any valid IP. (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
        }
        return result;
      }

      // 5. Comparação dos IPs
      if (result.serverIp !== result.proxyIp) {
        result.success = true;
        result.code = 'ok1';
        result.reason = `Proxy is working. IP changed successfully. (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
      } else {
        result.code = 'error1';
        result.reason = `Proxy connected, but IP did not change (transparent proxy?). (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
      }

      return result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          result.code = 'error2';
          result.reason = `Connection refused (proxy offline or wrong host/port). (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
        } else if (error.code === 'ETIMEDOUT') {
          result.code = 'error3';
          result.reason = `Connection timed out (proxy too slow or blocked). (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
        } else if (error.response?.status === 403) {
          result.code = 'error7';
          result.reason = `Access forbidden (proxy blocked or wrong credentials). (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
        } else {
          result.code = 'error5';
          result.reason = `Axios error: ${error.message} (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
        }
      } else {
        result.code = 'error6';
        result.reason = `Unknown error: ${String(error)} (Server IP: ${result.serverIp}, Proxy IP: ${result.proxyIp})`;
      }

      logger.error(`testProxy failed [${result.code}]: ${result.reason}`);
      return result;
    }
  }
}
