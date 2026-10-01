// Login PPPoE do equipamento, onde quer que o modelo de dados o guarde.
// É por ele que o MoviControl acha o equipamento de cada cliente do IXC: uma
// consulta só ("VirtualParameters.pppoe_login" = login), nos dois modelos.
const prazo = Date.now() - 270 * 1000;
let login = "";
for (const p of declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username",
  {path: Date.now(86400000), value: prazo})) {
  if (p.value && p.value[0]) { login = p.value[0]; break; }
}
if (!login) {
  for (const p of declare("Device.PPP.Interface.*.Username", {path: Date.now(86400000), value: prazo})) {
    if (p.value && p.value[0]) { login = p.value[0]; break; }
  }
}
return {writable: false, value: [String(login).trim().toLowerCase(), "xsd:string"]};
