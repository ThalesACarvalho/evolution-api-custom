import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

type Proxy = {
  host: string;
  password?: string;
  port: string;
  protocol: string;
  username?: string;
};

export function makeProxyAgent(proxy: Proxy | string) {
  let proxyUrl: string;

  if (typeof proxy === 'string') {
    proxyUrl = proxy;
  } else {
    const { host, password, port, protocol, username } = proxy;
    proxyUrl = `${protocol}://${username && password ? `${username}:${password}@` : ''}${host}:${port}`;
  }

  const agentOptions = {
    rejectUnauthorized: false, // Ignora certificados autoassinados
  };

  if (proxyUrl.startsWith('http:')) {
    return new HttpProxyAgent(proxyUrl, agentOptions);
  } else {
    return new HttpsProxyAgent(proxyUrl, agentOptions);
  }
}
