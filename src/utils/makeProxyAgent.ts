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

  // Se for HTTP → usa HttpProxyAgent, se for HTTPS → usa HttpsProxyAgent
  return proxyUrl.startsWith('http:')
    ? new HttpProxyAgent({ ...agentOptions, ...{ proxy: proxyUrl } })
    : new HttpsProxyAgent({ ...agentOptions, ...{ proxy: proxyUrl } });
}
