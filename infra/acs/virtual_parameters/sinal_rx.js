// Potência óptica recebida (dBm), num lugar só — cada fabricante a guarda num
// campo diferente e numa unidade diferente. Vazio quando o equipamento não é
// ONU (roteador atrás de uma ONU em ponte) ou não informa o sinal.
const prazo = Date.now() - 270 * 1000;
const diario = Date.now(86400000);
const candidatos = [
  "InternetGatewayDevice.WANDevice.*.X_GponInterafceConfig.RXPower",
  "InternetGatewayDevice.WANDevice.*.X_ZTE-COM_WANPONInterfaceConfig.RXPower",
  "InternetGatewayDevice.WANDevice.*.X_FH_GponInterfaceConfig.RXPower",
  "InternetGatewayDevice.WANDevice.*.X_CT-COM_GponInterfaceConfig.RXPower",
  "InternetGatewayDevice.WANDevice.*.X_CMCC_GponInterfaceConfig.RXPower",
  "InternetGatewayDevice.X_ALU_OntOpticalParam.RxOpticalPower",
  "Device.Optical.Interface.*.OpticalSignalLevel",
];
let dbm = null;
for (const caminho of candidatos) {
  for (const p of declare(caminho, {path: diario, value: prazo})) {
    if (!p.value || p.value[0] === "" || p.value[0] == null) continue;
    let v = parseFloat(String(p.value[0]).replace(",", "."));
    if (!isFinite(v)) continue;
    // TR-181 e alguns ZTE mandam em milésimos de dBm (-19400 = -19,4 dBm)
    if (v <= -100) v = v / 1000;
    // valor positivo é potência em microwatt (alguns ZTE, em décimos de µW)
    else if (v > 0) v = 10 * Math.log10((caminho.indexOf("ZTE") >= 0 ? v / 10 : v) / 1000);
    dbm = Math.round(v * 100) / 100;
    break;
  }
  if (dbm !== null) break;
}
return {writable: false, value: [dbm === null ? "" : String(dbm), "xsd:string"]};
