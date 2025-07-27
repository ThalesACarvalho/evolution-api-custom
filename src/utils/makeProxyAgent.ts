import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

type Proxy = {
  host: string;
  password?: string;
  port: string;
  protocol?: string;
  username?: string;
};

export function makeProxyAgent(proxy: Proxy | string) {
  let proxyUrl: string;

  if (typeof proxy === 'string') {
    // ✅ Se vier um IP puro ou host sem protocolo, assume HTTP
    proxyUrl = proxy.includes('://') ? proxy : `http://${proxy}`;
  } else {
    let { host, password, port, protocol, username } = proxy;

    // ✅ Se não especificar protocolo, assume HTTP por padrão
    if (!protocol || protocol.trim() === '') {
      protocol = 'http';
    }

    // ✅ Monta a URL corretamente (com ou sem user/pass)
    proxyUrl = `${protocol}://${username && password ? `${username}:${password}@` : ''}${host}:${port}`;
  }

  const agentOptions = {
    rejectUnauthorized: false, // Aceita proxies com certificados autoassinados
  };

  return proxyUrl.startsWith('https:')
    ? new HttpsProxyAgent(proxyUrl, agentOptions)
    : new HttpProxyAgent(proxyUrl, agentOptions);
}
