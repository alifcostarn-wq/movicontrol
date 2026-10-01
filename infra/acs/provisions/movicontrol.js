// MoviControl — provision executada pelo GenieACS a cada contato do equipamento.
//
// O ACS só guarda o que o equipamento manda espontaneamente (meia dúzia de
// parâmetros). Tudo o que o painel mostra — Wi-Fi, aparelhos conectados, login
// PPPoE, sinal da fibra — precisa ser PEDIDO, e é isto que pede. Os prazos
// abaixo dizem de quanto em quanto tempo cada informação é renovada; dentro do
// prazo o GenieACS não pergunta de novo, então a conversa com o equipamento
// fica curta.
//
// Vale para os dois modelos de dados: TR-098 (InternetGatewayDevice.*, a maioria
// das ONUs) e TR-181 (Device.*, roteadores mais novos).

const agora = Date.now();
const CONTATO_SEG = 300;                       // um contato a cada 5 min
const fresco = agora - (CONTATO_SEG - 30) * 1000;
const diario = Date.now(86400000);             // arredonda para o dia: muda 1x por dia

// ---- credenciais do connection request e contato periódico ---------------
// Mesma receita do provision "inform" que o GenieACS instala pela interface:
// usuário = id do equipamento; senha fixa por equipamento (o Math.random do
// GenieACS é semeado com o id). É o que permite ao ACS "acordar" o equipamento
// na hora em que o atendente clica em trocar a senha ou reiniciar.
const usuario = declare("DeviceID.ID", {value: 1}).value[0];
const senha = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
// espalha os contatos ao longo dos 5 min, para não chegar todo mundo junto
const horaContato = diario % 86400000 + Math.trunc(Math.random() * CONTATO_SEG) * 1000;

for (const raiz of ["InternetGatewayDevice", "Device"]) {
  const ms = raiz + ".ManagementServer.";
  declare(ms + "ConnectionRequestUsername", {value: diario}, {value: usuario});
  declare(ms + "ConnectionRequestPassword", {value: diario}, {value: senha});
  declare(ms + "PeriodicInformEnable", {value: diario}, {value: true});
  declare(ms + "PeriodicInformInterval", {value: diario}, {value: CONTATO_SEG});
  declare(ms + "PeriodicInformTime", {value: diario}, {value: horaContato});
}

// ---- identidade (1x por dia) e tempo ligado (a cada contato) ---------------
for (const raiz of ["InternetGatewayDevice", "Device"]) {
  for (const p of ["Manufacturer", "ModelName", "ProductClass", "SerialNumber", "SoftwareVersion", "HardwareVersion"]) {
    declare(raiz + ".DeviceInfo." + p, {path: diario, value: diario});
  }
  declare(raiz + ".DeviceInfo.UpTime", {path: diario, value: fresco});
}

// ---- TR-098 -----------------------------------------------------------------
const IGD = "InternetGatewayDevice.";
// conexão PPPoE: é o login que liga o equipamento ao cliente do IXC
for (const p of ["Username", "ConnectionStatus", "ExternalIPAddress", "Uptime", "LastConnectionError"]) {
  declare(IGD + "WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*." + p, {path: diario, value: fresco});
}
// Wi-Fi: nome, liga/desliga, canal, padrão e quantos aparelhos estão nele
for (const p of ["SSID", "Enable", "Channel", "Standard", "OperatingFrequencyBand", "TotalAssociations", "BeaconType"]) {
  declare(IGD + "LANDevice.*.WLANConfiguration.*." + p, {path: diario, value: fresco});
}
// onde mora a senha muda de fabricante para fabricante: só a EXISTÊNCIA do
// campo interessa (para saber onde gravar); o valor nunca é lido
declare(IGD + "LANDevice.*.WLANConfiguration.*.KeyPassphrase", {path: diario});
declare(IGD + "LANDevice.*.WLANConfiguration.*.PreSharedKey.*.PreSharedKey", {path: diario});
declare(IGD + "LANDevice.*.WLANConfiguration.*.PreSharedKey.*.KeyPassphrase", {path: diario});
// aparelhos na rede da casa
declare(IGD + "LANDevice.*.Hosts.Host.*.*", {path: fresco, value: fresco});
// sinal da fibra — cada fabricante põe num lugar (o "Interafce" da Huawei é
// erro de digitação de fábrica, e é assim mesmo que o campo se chama)
for (const p of [
  "WANDevice.*.X_GponInterafceConfig.RXPower", "WANDevice.*.X_GponInterafceConfig.TXPower",
  "WANDevice.*.X_ZTE-COM_WANPONInterfaceConfig.RXPower", "WANDevice.*.X_ZTE-COM_WANPONInterfaceConfig.TXPower",
  "WANDevice.*.X_FH_GponInterfaceConfig.RXPower", "WANDevice.*.X_FH_GponInterfaceConfig.TXPower",
  "WANDevice.*.X_CT-COM_GponInterfaceConfig.RXPower", "WANDevice.*.X_CMCC_GponInterfaceConfig.RXPower",
  "X_ALU_OntOpticalParam.RxOpticalPower", "X_ALU_OntOpticalParam.TxOpticalPower",
]) {
  declare(IGD + p, {path: diario, value: fresco});
}

// ---- TR-181 -----------------------------------------------------------------
const D = "Device.";
for (const p of ["Username", "Status", "LastConnectionError"]) declare(D + "PPP.Interface.*." + p, {path: diario, value: fresco});
declare(D + "IP.Interface.*.IPv4Address.*.IPAddress", {path: diario, value: fresco});
for (const p of ["SSID", "Enable", "LowerLayers"]) declare(D + "WiFi.SSID.*." + p, {path: diario, value: fresco});
for (const p of ["OperatingFrequencyBand", "Channel", "OperatingStandards"]) declare(D + "WiFi.Radio.*." + p, {path: diario, value: fresco});
for (const p of ["SSIDReference", "AssociatedDeviceNumberOfEntries", "Security.ModeEnabled"]) declare(D + "WiFi.AccessPoint.*." + p, {path: diario, value: fresco});
declare(D + "WiFi.AccessPoint.*.Security.KeyPassphrase", {path: diario});
declare(D + "Hosts.Host.*.*", {path: fresco, value: fresco});
declare(D + "Optical.Interface.*.OpticalSignalLevel", {path: diario, value: fresco});
declare(D + "Optical.Interface.*.TransmitOpticalLevel", {path: diario, value: fresco});

// ---- diagnósticos: quais testes o equipamento faz (1x por dia) -------------
// Só os NOMES dos campos, sem valores: é o que o MoviControl precisa para
// saber se o modelo faz ping/velocidade/rota e quais campos pode preencher.
// O resultado é lido pela provision movicontrol-diag, quando o teste acaba.
for (const base of [
  "InternetGatewayDevice.IPPingDiagnostics.", "InternetGatewayDevice.DownloadDiagnostics.",
  "InternetGatewayDevice.TraceRouteDiagnostics.",
  "Device.IP.Diagnostics.IPPing.", "Device.IP.Diagnostics.DownloadDiagnostics.",
  "Device.IP.Diagnostics.TraceRoute.",
]) {
  declare(base + "*", {path: diario});
}

// ---- atalhos que o MoviControl consulta (parâmetros virtuais) --------------
declare("VirtualParameters.pppoe_login", {value: fresco});
declare("VirtualParameters.sinal_rx", {value: fresco});
