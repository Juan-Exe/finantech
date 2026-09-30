# FinanTech — Prototipo funcional de Arquitectura Empresarial

Prototipo ejecutable de la arquitectura objetivo (TO-BE) propuesta en el taller **"Diseño de una arquitectura de integración para la transformación digital de FinanTech"** (Gestión de TI Empresarial, Universidad Cooperativa de Colombia, Montería, 2026).

**Integrantes:** Juan Diego, Sarah Montes, Brayan Parra, Ángel · **Docente:** Manuel de Jesús Giraldo Carriazo

El prototipo integra el flujo pedido en el reto:

```
Cliente → App/Web → Autenticación → Crédito → Evaluación → Aprobación → Desembolso → Contabilidad
```

## Cómo ejecutarlo

Solo necesita **Node.js 20 o superior**. No hay dependencias que instalar.

```bash
npm start        # levanta el bus, 8 microservicios y el API Gateway
                 # abrir http://localhost:8080
npm test         # prueba de extremo a extremo (instancia aislada, 26 verificaciones)
npm run reset    # borra los datos para empezar la demo desde cero
```

| Usuario | Correo | Contraseña |
|---|---|---|
| Gerencia / Admin | `admin@finantech.co` | `Admin2026!` |
| Analista de crédito | `analista@finantech.co` | `Analista2026!` |
| Cliente | se crea desde "Crear cuenta" | — |

En modo demostración, el código OTP (que en producción llegaría por SMS o correo) se muestra en pantalla.

## Las 5 capas en el código

| Capa | Componente | Carpeta | Puerto |
|---|---|---|---|
| 1. Canales | Portal web y app móvil (el mismo cliente sobre los mismos servicios; selector "Web / App móvil") | [web/](web/) | 8080 |
| 2. API Gateway | JWT, control de acceso por rol, límites de uso, enrutamiento, auditoría encadenada por hash, cabeceras de seguridad | [gateway/](gateway/) | 8080 |
| 3. Microservicios | Identidad, Clientes, Créditos, Evaluación, Desembolso y pagos, Contabilidad, Notificaciones | [services/](services/) | 4001–4007 |
| 4. Bus de eventos | Publicación/suscripción por HTTP, entrega ordenada, reintentos, outbox, idempotencia | [event-bus/](event-bus/) | 4100 |
| 5. Datos | Una base por servicio (`data/<servicio>.json`), registro maestro de clientes y bodega analítica | [data/](data/), [services/analytics/](services/analytics/) | 4008 |

Cada microservicio corre en **su propio proceso**, con su propio almacenamiento, y **vuelve a validar el token** aunque la llamada venga del gateway (confianza cero).

### Dueño único del dato

| Servicio | Es dueño de | Consume |
|---|---|---|
| Identidad | Credenciales, OTP, dispositivos confiables, roles | — |
| Clientes | Registro maestro, KYC, SARLAFT, consentimiento (Ley 1581) | — |
| Créditos | Solicitudes, contratos, plan de amortización, saldos | `evaluation.completed`, `disbursement.*`, `payment.received` |
| Evaluación | Reglas, puntaje y decisión trazable | `credit.requested` |
| Desembolso y pagos | Órdenes ACH, recaudo PSE | `credit.formalized` |
| Contabilidad | Asientos en partida doble, balance de prueba | `disbursement.completed`, `payment.received` |
| Notificaciones | Mensajes enviados (correo, SMS, push) | hitos del cliente y del crédito |
| Analítica | Bodega de hechos y KPI | `*` (todos los eventos) |

Créditos guarda solo el `customerId`; los datos del cliente se consultan por API al servicio de Clientes, nunca se copian.

## Qué se puede demostrar

| Concepto del taller | Dónde verlo |
|---|---|
| Identidad digital: MFA, seguridad adaptativa | Primer inicio de sesión en un navegador → OTP. Siguientes inicios → dispositivo reconocido, sin OTP. |
| Step-up (sección 9.5) | Para firmar un crédito mayor a $10.000.000 se pide un OTP reforzado. |
| Vinculación digital, KYC, SARLAFT | Formulario de vinculación con prueba de vida simulada y autorización de datos. |
| Datos maestros (MDM) | Un segundo registro con el mismo documento se rechaza. |
| Decisión automática y revisión manual | Motor de reglas → aprobación automática o cola del analista. |
| Mínimo privilegio | El analista ve documento, teléfono y dirección enmascarados. |
| Patrón saga (compensación) | Cuenta terminada en `000` → rechazo ACH → el crédito vuelve a "aprobada" para corregir la cuenta. |
| Contabilidad por eventos | Menú Contabilidad: asientos automáticos y balance de prueba cuadrado. |
| Bodega analítica | Tablero: embudo, % de decisión automática y tiempo de solicitud a desembolso en segundos. |
| Trazabilidad y auditoría | Menú Auditoría: quién, qué, cuándo y por qué canal, con verificación de integridad. |
| Bus de eventos | Menú Bus de eventos: cada evento con sus entregas por suscriptor. |

### Datos de prueba (central de riesgo simulada)

| Documento | Resultado |
|---|---|
| Termina en `0` | Reporte negativo → rechazo automático |
| Termina en `5` | Historial insuficiente → revisión manual |
| Empieza por `999` | Coincidencia en lista SARLAFT → vinculación rechazada |
| Cualquier otro | Buen historial → aprobación automática (si el endeudamiento es ≤ 40 % y el monto ≤ $20M) |

## Política de riesgo del prototipo

- Puntaje en central de riesgo < 500 → rechazo.
- Endeudamiento (gastos + cuota) / ingresos > 60 % → rechazo.
- Puntaje ≥ 680, endeudamiento ≤ 40 % y monto ≤ $20.000.000 → aprobación automática.
- En otro caso → revisión manual por un analista.

## API (a través del gateway, prefijo `/api`)

| Método y ruta | Rol |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/mfa` | público |
| `POST /auth/step-up`, `POST /auth/step-up/verify` | autenticado |
| `GET /products`, `GET /credits/simulate` | público |
| `POST /customers`, `GET/PATCH /customers/me` | cliente |
| `GET /customers`, `GET /customers/:id` | analista, admin |
| `POST /credits`, `POST /credits/:id/sign`, `PATCH /credits/:id/account` | cliente |
| `GET /credits`, `GET /credits/:id` | cliente (solo los propios), analista, admin |
| `POST /credits/:id/review` | analista, admin |
| `POST /payments`, `GET /notifications/me` | cliente |
| `GET /accounting/entries`, `GET /accounting/trial-balance`, `GET /analytics/kpis` | analista, admin |
| `GET /bus/events`, `GET /bus/subscriptions`, `GET /audit` | admin |
| `GET /health` | público |

## Alcance del prototipo

Es un prototipo académico. El OTP, la biometría, la central de riesgo, ACH y PSE están **simulados**. En producción, la sección 5.4 del documento propone contenedores y orquestación, un bus gestionado (Kafka o RabbitMQ), bases de datos administradas, un proveedor OIDC, una bóveda de secretos y TLS de extremo a extremo.

El documento completo del taller está en [docs/](docs/).
