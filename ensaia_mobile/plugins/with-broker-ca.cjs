const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

module.exports = function withBrokerCa(config) {
  config = withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app.$['android:usesCleartextTraffic'] = 'false';
    if (existsSync(join(mod.modRequest.projectRoot, 'certs/broker-ca.crt'))) {
      app.$['android:networkSecurityConfig'] = '@xml/ensaia_network_security';
    }
    return mod;
  });

  return withDangerousMod(config, ['android', (mod) => {
    const certs = join(mod.modRequest.projectRoot, 'certs');
    const certificate = join(certs, 'broker-ca.crt');
    if (!existsSync(certificate)) return mod;
    const host = readFileSync(join(certs, 'broker-host.txt'), 'utf8').trim();
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(host)) throw new Error('Nombre de broker inválido.');
    const resources = join(mod.modRequest.platformProjectRoot, 'app/src/main/res');
    mkdirSync(join(resources, 'raw'), { recursive: true });
    mkdirSync(join(resources, 'xml'), { recursive: true });
    copyFileSync(certificate, join(resources, 'raw/ensaia_broker_ca.crt'));
    writeFileSync(join(resources, 'xml/ensaia_network_security.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">${host}</domain>
        <trust-anchors><certificates src="@raw/ensaia_broker_ca" /></trust-anchors>
    </domain-config>
</network-security-config>
`);
    return mod;
  }]);
};
