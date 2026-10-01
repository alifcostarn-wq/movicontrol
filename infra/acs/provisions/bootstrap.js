// Equipamento voltou ao padrão de fábrica (ou foi trocado por outro com o
// mesmo número de série): o que o ACS sabia dele não vale mais. Apaga para
// começar de novo — é o mesmo provision "bootstrap" que o GenieACS instala
// pela interface.
const agora = Date.now();
clear("Device", agora);
clear("InternetGatewayDevice", agora);
