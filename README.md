# FinanTech — Prototipo funcional de Arquitectura Empresarial

Prototipo ejecutable de la arquitectura objetivo (TO-BE) propuesta en el taller **"Diseño de una arquitectura de integración para la transformación digital de FinanTech"** (Gestión de TI Empresarial, Universidad Cooperativa de Colombia, Montería, 2026).

**Integrantes:** Juan Diego, Sarah Montes, Brayan Parra, Ángel · **Docente:** Manuel de Jesús Giraldo Carriazo

El prototipo implementa el flujo del reto de principio a fin:

```
Cliente → App/Web → Autenticación → Crédito → Evaluación → Aprobación → Desembolso → Contabilidad
```

---

## 1. Requisitos

| Requisito | Versión | Cómo verificarlo |
|---|---|---|
| [Node.js](https://nodejs.org) (incluye npm) | 20 o superior (recomendado: LTS) | `node --version` |
| [Git](https://git-scm.com) | cualquiera | `git --version` |
| Navegador | Chrome, Edge o Firefox actualizados | — |

**No hay que instalar librerías**: el proyecto no tiene dependencias externas, así que no hace falta `npm install`.

## 2. Ejecutarlo paso a paso

### Windows (PowerShell o CMD)

```powershell
# 1. Descargar el proyecto (solo la primera vez)
git clone https://github.com/Juan-Exe/finantech.git
cd finantech

# 2. Arrancar la plataforma completa
npm start
```

### macOS / Linux

```bash
git clone https://github.com/Juan-Exe/finantech.git
cd finantech
npm start
```

### 3. Abrir la aplicación

Cuando la terminal muestre el recuadro **"FinanTech — prototipo funcional"**, abra en el navegador:

**http://localhost:8080**

La app abre en la pantalla de **inicio de sesión**. Use los botones de **Acceso rápido** para entrar como Cliente, Analista o Gerencia.

**La primera vez** que se ejecuta, `npm start` carga automáticamente **7 clientes de ejemplo** haciéndolos pasar por el flujo real (registro, vinculación, solicitud, evaluación, firma, desembolso y pagos). Así la app arranca con créditos vigentes, solicitudes pendientes del analista, un rechazo y contabilidad con movimientos. Tarda unos 10 segundos.

Deje la terminal abierta mientras usa la aplicación: ahí se ve en vivo cómo los servicios se comunican (eventos del bus, asientos contables, notificaciones enviadas).

### 4. Detenerla

En la terminal donde corre, presione **Ctrl + C**. Se detienen todos los servicios.

### Resumen de comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Levanta el bus de eventos, los 8 microservicios y el API Gateway. |
| `npm test` | Ejecuta la prueba de extremo a extremo (26 verificaciones) en una instancia aislada: no toca sus datos ni necesita detener `npm start`. |
| `npm run reset` | Borra todos los datos. En el siguiente `npm start` se vuelven a cargar los clientes de ejemplo. Hágalo con la plataforma detenida. |
| `npm run seed` | Vuelve a cargar los clientes de ejemplo sobre una plataforma que ya está corriendo (solo si no existen). |

Para arrancar **sin** datos de ejemplo: `npm run reset` y luego `$env:SEED="false"; npm start` (PowerShell) o `SEED=false npm start` (macOS/Linux).

## 3. Usuarios

| Rol | Correo | Contraseña | Qué ve |
|---|---|---|---|
| Gerencia / Admin | `admin@finantech.co` | `Admin2026!` | Tablero, créditos, contabilidad, bus de eventos, auditoría |
| Analista de crédito | `analista@finantech.co` | `Analista2026!` | Cola de revisión manual, créditos, tablero, contabilidad |
| Cliente de ejemplo | `maria.gomez@correo.co` | `Cliente2026!` | Crédito vigente con 3 cuotas pagadas, notificaciones, perfil |
| Cliente nuevo | se crea con **"Crear cuenta"** | mínimo 8 caracteres, con letras y números | Vinculación digital y su primera solicitud |

### Clientes de ejemplo (todos con contraseña `Cliente2026!`)

| Cliente | Situación inicial |
|---|---|
| `maria.gomez@correo.co` | Libre inversión $8M vigente, 3 cuotas pagadas (canal app móvil) |
| `ana.torres@correo.co` | Libre inversión $12M vigente, firmado con OTP reforzado |
| `jorge.herrera@correo.co` | Educativo $4,5M vigente, 5 cuotas pagadas |
| `sofia.castro@correo.co` | Crédito aprobado, **pendiente de firma** (entre y fírmelo) |
| `carlos.ruiz@correo.co` | Vehículo $35M **en revisión manual** (monto > $20M) |
| `luisa.martinez@correo.co` | Educativo $3M **en revisión manual** (historial insuficiente) |
| `pedro.diaz@correo.co` | Solicitud **rechazada** (reporte negativo en central) |

**Código OTP:** la primera vez que un usuario entra desde un navegador, se pide un código de 6 dígitos. En este prototipo el código (que en producción llegaría por SMS o correo) **se muestra en pantalla**. Desde ese mismo navegador ya no se pide de nuevo, porque el dispositivo queda reconocido.

## 4. Datos de prueba

La central de riesgo, el banco y las listas de control están simulados. El resultado depende del número de documento y de la cuenta que se digiten:

| Si el documento… | Resultado |
|---|---|
| termina en `0` | Reporte negativo en central de riesgo → **rechazo automático** |
| termina en `5` | Historial insuficiente → **revisión manual** por el analista |
| empieza por `999` | Coincidencia en lista SARLAFT → **vinculación rechazada** |
| cualquier otro (ej. `1067894523`) | Buen historial → **aprobación automática** |

| Otros casos | Resultado |
|---|---|
| Cuenta bancaria terminada en `000` | El banco rechaza el desembolso → **compensación (saga)** |
| Monto mayor a $10.000.000 | Para firmar se pide un **OTP reforzado** |
| Monto mayor a $20.000.000 | Va a **revisión manual** aunque el cliente tenga buen historial |
| Endeudamiento (gastos + cuota) / ingresos mayor a 40 % | Revisión manual; si pasa de 60 %, rechazo |

Cada documento solo puede registrarse una vez (registro maestro único). Para repetir la demostración use documentos nuevos o ejecute `npm run reset`.

## 5. Guion sugerido para la presentación (≈10 minutos)

1. **Acceso rápido → Gerencia**: el tablero ya muestra la operación de los clientes de ejemplo. Recorrer **Clientes**, **Contabilidad**, **Bus de eventos** y **Auditoría**.
2. **Acceso rápido → Analista**: aprobar el crédito de Carlos o Luisa en **Revisión manual**.
3. **Salir → Crear cuenta** como cliente nuevo → aparece el OTP → **vinculación digital** con un documento terminado en `3`, prueba de vida y autorización de datos.
4. **Solicitar** $5.000.000 a 24 meses → la pantalla muestra en vivo la evaluación, luego **Aprobada**.
5. **Firmar electrónicamente** → el desembolso llega solo → aparece el plan de amortización → **Pagar cuota**.
6. Abrir la app desde el **celular** (misma red, ver sección 7): se adapta a la pantalla y la solicitud queda registrada por el canal **app móvil**.
7. Volver a **Gerencia**: el tablero, la contabilidad y la auditoría ya incluyen el crédito recién creado. El tiempo de solicitud a desembolso se mide **en segundos** (antes eran días).
8. Opcional: una cuenta terminada en `000` → ver la **compensación** y corregir la cuenta.

## 6. Arquitectura

### Las 5 capas en el código

| Capa | Componente | Carpeta | Puerto |
|---|---|---|---|
| 1. Canales | Portal web y app móvil sobre los mismos servicios (el canal se detecta por el tamaño de pantalla) | [web/](web/) | 8080 |
| 2. API Gateway | Token JWT, control de acceso por rol, límites de uso, enrutamiento, auditoría encadenada por hash, cabeceras de seguridad | [gateway/](gateway/) | 8080 |
| 3. Microservicios | Identidad, Clientes, Créditos, Evaluación, Desembolso y pagos, Contabilidad, Notificaciones | [services/](services/) | 4001–4007 |
| 4. Bus de eventos | Publicación/suscripción, entrega ordenada, reintentos, outbox, idempotencia | [event-bus/](event-bus/) | 4100 |
| 5. Datos | Una base por servicio (`data/<servicio>.json`), registro maestro de clientes y bodega analítica | `data/`, [services/analytics/](services/analytics/) | 4008 |

Cada microservicio corre en **su propio proceso**, guarda **solo sus propios datos** y **vuelve a validar el token** aunque la llamada venga del gateway (confianza cero). Los servicios no se llaman entre sí para avanzar el proceso: publican eventos en el bus.

### Dueño único del dato

| Servicio | Es dueño de | Escucha los eventos |
|---|---|---|
| Identidad | Credenciales, OTP, dispositivos confiables, roles | — |
| Clientes | Registro maestro, KYC, SARLAFT, consentimiento (Ley 1581) | — |
| Créditos | Solicitudes, contratos, plan de amortización, saldos | `evaluation.completed`, `disbursement.completed`, `disbursement.failed`, `payment.received` |
| Evaluación | Reglas, puntaje y decisión trazable | `credit.requested` |
| Desembolso y pagos | Órdenes ACH, recaudo PSE | `credit.formalized` |
| Contabilidad | Asientos en partida doble, balance de prueba | `disbursement.completed`, `payment.received` |
| Notificaciones | Mensajes enviados (correo, SMS, push) | hitos del cliente y del crédito |
| Analítica | Bodega de hechos y KPI | todos (`*`) |

Créditos guarda solo el `customerId`: los datos del cliente se consultan por API al servicio de Clientes y nunca se copian.

### Qué concepto del taller demuestra cada parte

| Concepto | Dónde verlo |
|---|---|
| Identidad digital, MFA y seguridad adaptativa (sección 6.1 y 9.5) | OTP en dispositivo nuevo; sin OTP en dispositivo reconocido; OTP reforzado al firmar montos altos. Bloqueo de la cuenta tras 5 intentos fallidos. |
| Vinculación digital, KYC y SARLAFT (6.1, 6.3) | Formulario de vinculación con prueba de vida y autorización de datos. |
| Gestión de datos maestros (4.3.5) | No se permite registrar dos veces el mismo documento. |
| Decisión automática y revisión manual (5.1) | Motor de reglas con decisión trazable; cola del analista. |
| Mínimo privilegio (6.1) | El analista ve documento, teléfono y dirección enmascarados. |
| Patrón saga (4.3.4) | Cuenta terminada en `000`: el crédito vuelve a "aprobada" para corregir la cuenta. |
| Contabilidad como suscriptor del bus (sección 7) | Menú Contabilidad: asientos automáticos y balance cuadrado. |
| Bodega analítica (4.3.5) | Tablero de gestión alimentado solo por eventos. |
| Trazabilidad y auditoría (4.3.2, 6.2) | Menú Auditoría: registros encadenados por hash, con verificación de integridad. |
| Observabilidad (5.4) | Estado y latencia de cada servicio en el Tablero de gerencia. |

### Estructura del proyecto

```
finantech/
├── web/                 Capa 1: canales (HTML, CSS y JavaScript sin frameworks)
├── gateway/             Capa 2: API Gateway
├── services/            Capa 3: un microservicio por carpeta
│   ├── identity/  customers/  credits/  evaluation/
│   ├── disbursement/  accounting/  notifications/  analytics/
├── event-bus/           Capa 4: bus de eventos
├── shared/              Utilidades comunes (HTTP, JWT, cliente del bus, almacenamiento)
├── scripts/             start.js (arranque), seed.js (datos de ejemplo), e2e.js (pruebas), reset.js
├── docs/                Documento del taller y enunciado del reto
└── data/                Capa 5: se crea al ejecutar; una base por servicio (no se sube a git)
```

## 7. Solución de problemas

| Problema | Solución |
|---|---|
| `"node" no se reconoce como un comando` | Instale Node.js desde https://nodejs.org, **cierre y vuelva a abrir** la terminal. |
| `El puerto 8080 ya está en uso` | Probablemente ya hay una copia abierta: ciérrela con Ctrl + C. Si otro programa usa ese puerto, cambie el del gateway (ver abajo). |
| `El puerto 4001… ya está en uso` | Hay otra copia de FinanTech corriendo: ciérrela (no abra dos copias a la vez, comparten la carpeta `data/`). Si es otro programa el que ocupa esos puertos, desplácelos con `PORT_OFFSET` (ver abajo). |
| La página muestra "Sesión expirada" | Las sesiones duran 1 hora; vuelva a ingresar. |
| "Ya existe un cliente con este documento" | Use otro número de documento o ejecute `npm run reset`. |
| Quiero ver la app en otro equipo de la red | Arranque con `HOST=0.0.0.0` (ver abajo) y abra `http://<IP-del-equipo>:8080`. |

Cambiar puertos o la interfaz de red:

```powershell
# PowerShell (Windows)
$env:PORT = "3000"; npm start          # gateway en http://localhost:3000
$env:PORT_OFFSET = "100"; npm start    # todos los puertos +100 (gateway en 8180)
$env:HOST = "0.0.0.0"; npm start       # accesible desde otros equipos de la red
```

```bash
# macOS / Linux / Git Bash
PORT=3000 npm start
PORT_OFFSET=100 npm start
HOST=0.0.0.0 npm start
```

## 8. API

Todas las rutas pasan por el gateway con el prefijo `/api` y, salvo las públicas, requieren el encabezado `Authorization: Bearer <token>`.

| Método y ruta | Rol |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/mfa` | público |
| `POST /auth/step-up`, `POST /auth/step-up/verify` | autenticado |
| `GET /products`, `GET /credits/simulate?product=&amount=&term=` | público |
| `POST /customers`, `GET /customers/me`, `PATCH /customers/me` | cliente |
| `GET /customers`, `GET /customers/:id` | analista, admin |
| `POST /credits`, `POST /credits/:id/sign`, `PATCH /credits/:id/account` | cliente |
| `GET /credits`, `GET /credits/:id` | cliente (solo los propios), analista, admin |
| `POST /credits/:id/review` | analista, admin |
| `POST /payments`, `GET /notifications/me` | cliente |
| `GET /accounting/entries`, `GET /accounting/trial-balance`, `GET /analytics/kpis` | analista, admin |
| `GET /bus/events`, `GET /bus/subscriptions`, `GET /audit` | admin |
| `GET /health` | público |

## 9. Alcance

Es un prototipo académico: el OTP, la biometría, la central de riesgo, ACH, PSE y las listas SARLAFT están **simulados**, y los datos se guardan en archivos JSON locales. Para producción, la sección 5.4 del documento propone contenedores con orquestación, un bus gestionado (Kafka o RabbitMQ), bases de datos administradas por servicio, un proveedor de identidad OpenID Connect, una bóveda de secretos y TLS de extremo a extremo.

El documento completo del taller y el enunciado del reto están en [docs/](docs/).
