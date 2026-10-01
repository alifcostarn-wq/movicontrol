// MoviControl — roda quando o equipamento avisa "8 DIAGNOSTICS COMPLETE".
//
// O equipamento faz o teste sozinho (ping, velocidade, rota) e, quando acaba,
// procura o ACS para avisar. Sem esta provision o resultado ficava no
// equipamento e o painel continuava mostrando "testando…". Aqui ele é lido na
// mesma conversa do aviso.

const agora = Date.now();
for (const base of [
  "InternetGatewayDevice.IPPingDiagnostics.",
  "InternetGatewayDevice.DownloadDiagnostics.",
  "InternetGatewayDevice.UploadDiagnostics.",
  "InternetGatewayDevice.TraceRouteDiagnostics.",
  "Device.IP.Diagnostics.IPPing.",
  "Device.IP.Diagnostics.DownloadDiagnostics.",
  "Device.IP.Diagnostics.UploadDiagnostics.",
  "Device.IP.Diagnostics.TraceRoute.",
]) {
  declare(base + "*", {path: agora, value: agora});
}
declare("InternetGatewayDevice.TraceRouteDiagnostics.RouteHops.*.*", {path: agora, value: agora});
declare("Device.IP.Diagnostics.TraceRoute.RouteHops.*.*", {path: agora, value: agora});
