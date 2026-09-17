# Proxy de salida con IP fija (DigitalOcean)

CT Online sólo acepta llamadas desde IPs registradas. Railway Hobby no tiene IP
fija, así que las llamadas a CT salen por un Droplet con Caddy:

```
api-ct (Railway) ──HTTPS + X-Proxy-Key──▶ Droplet (Caddy) ──HTTPS──▶ api.ctonline.mx
                                           IP fija que conoce CT
```

El Droplet **no guarda datos**. Si se pierde se reinstala con este script, pero
la IP cambia y hay que avisar a CT: **nunca lo destruyas**. Apagarlo, reiniciarlo
o redimensionarlo conserva la IP.

## 1. Crear el Droplet (tú)

1. DigitalOcean → **Create → Droplets**.
2. Región: San Francisco o Nueva York. Imagen: **Ubuntu 24.04 LTS**.
3. Plan: **Basic → Regular → $4/mes** (512 MB).
4. Authentication: **SSH Key** → pega la llave pública (`schu_digitalocean.pub`).
5. Nombre: `schu-ct-proxy`. Create.
6. Copia la **IPv4** del Droplet.

## 2. Instalar el proxy

Genera la clave del proxy (sólo letras y números):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Desde `D:\api-ct`, con la IP del Droplet:

```bash
scp -i ~/.ssh/schu_digitalocean -r deploy/proxy root@IP_DEL_DROPLET:/root/proxy
ssh -i ~/.ssh/schu_digitalocean root@IP_DEL_DROPLET "CLAVE_PROXY=LA_CLAVE bash /root/proxy/instalar.sh"
```

Al terminar imprime la **IP para CT** y el **CT_BASE_URL**.

## 3. Railway

En el servicio `api-ct` → Variables:

```
CT_BASE_URL=https://IP-CON-GUIONES.sslip.io
CT_PROXY_KEY=LA_CLAVE
```

Deploy. `/health` muestra `ct.proxy: true`.

## 4. Verificar

```bash
curl https://IP-CON-GUIONES.sslip.io/__proxy/salud          # ok
curl -i https://IP-CON-GUIONES.sslip.io/pedido/listar        # 403: sin clave no pasa
curl -i -H "X-Proxy-Key: LA_CLAVE" https://IP-CON-GUIONES.sslip.io/pedido/listar
# responde CT (401 mientras no haya token): el proxy sí reenvía
```

## Seguridad

DigitalOcean **por defecto** sólo da: red con protección DDoS básica, la llave
SSH que elegiste y el sistema recién instalado. **No** activa firewall,
actualizaciones automáticas ni bloqueo de intentos. Eso lo pone `instalar.sh`:

| Capa | Qué hace | Quién |
|---|---|---|
| SSH sólo con llave | Sin contraseñas: nadie entra adivinando | `instalar.sh` |
| fail2ban | Bloquea IPs que insisten en SSH | `instalar.sh` |
| Firewall (ufw) | Sólo abre 22, 80 y 443 | `instalar.sh` |
| Actualizaciones automáticas | Parches de seguridad diarios; reinicia a las 3:00 (CDMX) si hace falta | `instalar.sh` |
| HTTPS | Certificado gratuito que Caddy renueva solo | `instalar.sh` |
| Clave del proxy | Sin `X-Proxy-Key` correcta: 403. Nadie más usa tu IP | `instalar.sh` |
| Métricas | Gráficas de CPU, memoria y disco en el panel | `instalar.sh` (do-agent) |

Tú, en el panel de DigitalOcean:

1. **Activa 2FA** en tu cuenta (Settings → Security). Es lo más importante:
   quien entre a tu cuenta puede borrar el Droplet y su IP.
2. **Cloud Firewall** (gratis), segunda capa por fuera del servidor:
   Networking → Firewalls → Create. Entrada: SSH (22), HTTP (80), HTTPS (443).
   Salida: todo. Aplícalo al Droplet `schu-ct-proxy`.
3. **Alerta de monitoreo**: Monitoring → Create alert → CPU > 80 % por 5 min
   (y opcionalmente "Droplet down"), con aviso a tu correo.
4. **Alerta de facturación**: Billing → Billing alerts → $10 USD.

Respaldos del Droplet no hacen falta: no guarda datos y se reinstala con el script.

## Mantenimiento

- Las actualizaciones de seguridad se instalan solas y el servidor se reinicia
  solo si lo necesita (la IP se conserva).
- Logs del proxy: `/var/log/caddy/proxy-ct.log`.
- Cambiar la clave: vuelve a correr `instalar.sh` con la nueva y actualiza
  `CT_PROXY_KEY` en Railway.
- Dejar de usarlo: en Railway regresa `CT_BASE_URL=https://api.ctonline.mx` y
  borra `CT_PROXY_KEY`.
