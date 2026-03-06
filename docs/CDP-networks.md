# CDP & Puppeteer — Guía práctica para HAR capture

> Guía de referencia rápida para crawlers Node.js con Puppeteer CDPSession + chrome-har.
> Generado con Claude Sonnet 4.6 (`claude-sonnet-4-6`)

---

## Índice

1. [Ciclo de vida de una request](#1-ciclo-de-vida-de-una-request)
2. [Network idle](#2-network-idle)
3. [Targets y sesiones](#3-targets-y-sesiones)
4. [Eventos de página](#4-eventos-de-página)
5. [Captura del body](#5-captura-del-body)
6. [Attachment y waitForDebuggerOnStart](#6-attachment-y-waitfordebuggeronstart)
7. [Race conditions en multi-sesión](#7-race-conditions-en-multi-sesión)
8. [Casos problemáticos en HAR capture](#8-casos-problemáticos-en-har-capture)
9. [Patrones JS/JSDoc](#9-patrones-jsjsdoc)

---

## 1. Ciclo de vida de una request

El orden de eventos para una request normal es:

```
requestWillBeSent          → el renderer decide hacer la request
requestWillBeSentExtraInfo → el browser process añade cookies reales al wire
responseReceived           → headers de respuesta recibidos
responseReceivedExtraInfo  → headers reales del wire (incluyendo Set-Cookie HttpOnly)
dataReceived               → chunks del body (0..N veces)
loadingFinished            → body completo, ya puedes llamar getResponseBody
  — o —
loadingFailed              → error (net::ERR_*, cancelado, bloqueado)
```

**¿Por qué dos streams paralelos?**
Chrome separa renderer process y browser process. El renderer no tiene acceso a las cookies HttpOnly — solo el browser process las adjunta al wire. Por eso `requestWillBeSentExtraInfo` es el único sitio donde ves las cookies reales enviadas, y `responseReceivedExtraInfo` el único donde ves `Set-Cookie` con valores HttpOnly.

> ⚠️ `requestWillBeSentExtraInfo` puede llegar **antes** que `requestWillBeSent`. Correla siempre por `requestId`, no por orden de llegada.

**Docs:** [Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/) · [requestWillBeSent](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestWillBeSent) · [responseReceived](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-responseReceived) · [loadingFinished](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-loadingFinished)

---

## 2. Network idle

Puppeteer no usa ningún concepto interno de Chrome — lo sintetiza contando eventos:

| `waitUntil` | Condición | Debounce |
|---|---|---|
| `networkidle0` | 0 requests en vuelo | 500ms |
| `networkidle2` | ≤2 requests en vuelo | 500ms |

Cada `requestWillBeSent` suma 1, cada `loadingFinished`/`loadingFailed` resta 1.

**Casos donde falla:**
- **Long-polling / SSE** — la conexión nunca cierra, el contador nunca llega a 0
- **SPAs con setTimeout** — la red se queda idle, Puppeteer resuelve, y luego llega la segunda oleada de requests
- **Service workers precaching** — sus requests van por su propia sesión, invisibles para la página
- **WebSockets** — no cuentan en el contador, no bloquean idle

**Recomendación práctica:** usa `networkidle2` + timeout duro, y no declares "done" hasta que `Page.loadEventFired` haya disparado.

**Docs:** [waitForNavigation](https://pptr.dev/api/puppeteer.page.waitfornavigation) · [PuppeteerLifeCycleEvent](https://pptr.dev/api/puppeteer.puppeteerlifecycleevent)

---

## 3. Targets y sesiones

Cada target (página, iframe cross-process, worker, service worker) tiene su propia sesión CDP independiente con su propio stack de red. Los eventos de red **no burbujean** al padre.

**¿Cuándo Chrome crea un proceso nuevo para un iframe?**
- Iframe cross-site → siempre proceso propio (Site Isolation, activado por defecto desde Chrome 67)
- Iframe same-site → comparte proceso con el padre, sus eventos aparecen en la sesión del padre
- Si Chrome llega al límite de procesos → puede colapsar targets en el mismo proceso (no determinista)

**¿Por qué hay que llamar `Network.enable` en cada sesión?**
Porque `Network.enable` activa la instrumentación solo en el `NetworkHandler` de esa sesión concreta. No hay un enable global.

```javascript
// Hay que hacer esto en CADA sesión nueva
await session.send('Network.enable', {
  maxTotalBufferSize: 20 * 1024 * 1024,
  maxResourceBufferSize: 5 * 1024 * 1024,
});
```

**Docs:** [Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/) · [Network.enable](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-enable) · [Site Isolation](https://www.chromium.org/Home/chromium-security/site-isolation/)

---

## 4. Eventos de página

| Evento | Cuándo dispara | Equivalente web |
|---|---|---|
| `Page.frameStartedLoading` | El frame empieza a cargar | — |
| `Page.frameNavigated` | El frame hace commit de la navegación | — |
| `Page.domContentEventFired` | Parser terminado + scripts defer ejecutados | `DOMContentLoaded` |
| `Page.loadEventFired` | Todos los subresources cargados | `window.load` |
| `Page.frameStoppedLoading` | Carga del frame completamente terminada | — |
| `Page.navigatedWithinDocument` | Hash change o History API | No recarga |

Para un crawler, `Page.loadEventFired` es el suelo mínimo antes de declarar la navegación completa.

**Docs:** [Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/) · [loadEventFired](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-loadEventFired)

---

## 5. Captura del body

Tras `loadingFinished`, Chrome guarda el body en memoria en la sesión CDP. Puedes recuperarlo con `getResponseBody` hasta que lo expulse del buffer.

**Límites del buffer (`Network.enable`):**
- `maxTotalBufferSize` — máximo total para todos los bodies de esa sesión (default: 10 MB)
- `maxResourceBufferSize` — máximo por response individual (default: 5 MB)

**Cuándo falla `getResponseBody`:**
- La request terminó antes de que llamaras `Network.enable`
- El buffer se llenó y ese entry fue expulsado
- Response sin body (204, 304, HEAD)
- Response en streaming que nunca cierra (SSE)
- Usaste la sesión equivocada ← **error muy común**

**El body está ligado a la sesión que recibió `loadingFinished`.** Si el evento vino de la sesión del iframe, debes llamar `getResponseBody` en esa misma sesión, no en la de la página principal.

```javascript
session.on('Network.loadingFinished', async (event) => {
  // `session` está capturado en el closure — correcto
  const body = await session.send('Network.getResponseBody', {
    requestId: event.requestId,
  });
});
```

**Docs:** [getResponseBody](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody)

---

## 6. Attachment y `waitForDebuggerOnStart`

Cuando usas `Target.setAutoAttach` con `waitForDebuggerOnStart: true`, Chrome pausa el target antes de ejecutar nada. La ventana para instrumentar es:

```
attachedToTarget dispara
  → llamas Network.enable (y lo que necesites)
  → llamas Runtime.runIfWaitingForDebugger
  → el target reanuda ejecución
  → primera request → tú la capturas
```

Si llamas `Network.enable` **después** de `runIfWaitingForDebugger` en una página rápida, te pierdes la primera oleada de requests. El HAR saldrá incompleto.

**Propagación:** `setAutoAttach` solo aplica a los hijos directos de esa sesión. Para capturar iframes dentro de iframes, llama `setAutoAttach` también en cada sesión nueva que recibes.

**Docs:** [setAutoAttach](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach) · [attachedToTarget](https://chromedevtools.github.io/devtools-protocol/tot/Target/#event-attachedToTarget) · [runIfWaitingForDebugger](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-runIfWaitingForDebugger)

---

## 7. Race conditions en multi-sesión

### El problema con `Promise.all`

Si usas `Promise.all` para habilitar dominios en varias sesiones en paralelo y una sesión muerta rechaza, **todas las demás se cancelan**. Resultado: HAR vacío.

```javascript
// ❌ Mal — una sesión muerta mata todas las demás
await Promise.all(sessions.map(s => s.send('Network.enable', {})));

// ✅ Bien — los fallos son esperados, continúa con las que funcionan
await Promise.allSettled(sessions.map(s => s.send('Network.enable', {})));
```

### ¿Por qué Chrome adjunta el mismo target dos veces?

Pasa sobre todo con service workers ya registrados. Chrome crea dos sesiones para el mismo target. La primera queda obsoleta pero su WebSocket sigue abierto. Cualquier comando a esa sesión devolverá `"Session closed"` o `"Target already exists"`.

**Cómo detectar una sesión muerta:** `session.connection()` devuelve `null` una vez procesado el evento de detach. Pero hay una ventana donde aún no se ha procesado — no lo uses como pre-check. En su lugar, wrap con try/catch.

### Patrón defensivo

```javascript
async addTarget(session, targetInfo) {
  // Habilita dominios — ignora fallos de sesiones muertas
  await Promise.allSettled([
    session.send('Network.enable', {}),
    session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }),
  ]);

  session.on('Network.loadingFinished', async (event) => {
    try {
      const body = await session.send('Network.getResponseBody', {
        requestId: event.requestId,
      });
      this._bodies[event.requestId] = body;
    } catch {
      // Normal: body expirado, sesión cerrada, response sin body
    }
  });

  // Libera el target — catch por si no estaba pausado
  await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
}
```

**Docs:** [Promise.allSettled](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled) · [detachedFromTarget](https://chromedevtools.github.io/devtools-protocol/tot/Target/#event-detachedFromTarget)

---

## 8. Casos problemáticos en HAR capture

| Caso | Qué pasa | Cómo manejarlo |
|---|---|---|
| **requestId duplicado** | Único por sesión, no entre sesiones | Prefija con sessionId: `"${sessionId}::${requestId}"` |
| **Redirects** | El mismo `requestId` dispara varios `requestWillBeSent`, cada uno con `redirectResponse` | No sobreescribas en el Map — añade una entrada por evento |
| **Caché de memoria** | Solo dispara `requestServedFromCache`, no `responseReceived` | `getResponseBody` fallará — HAR entry sin timing ni body |
| **Caché de disco** | Secuencia completa pero `response.fromDiskCache === true` | Normal, funciona |
| **Preflight CORS** | OPTIONS con su propio `requestId`, sin link al request real | Dos entries separadas en el HAR, sin relación explícita |
| **SSE / chunked infinito** | `loadingFinished` nunca dispara | Detecta por content-type y maneja aparte o acepta que el body queda incompleto |
| **Service worker** | Puede responder de cache sin hacer network | `responseReceived` con `fromServiceWorker: true`, sin eventos de red |
| **QUIC / HTTP3** | `timing.connectStart` puede ser `-1` en 0-RTT | Clampea los timings a 0 para evitar negativos en el HAR |
| **304 / 204 / HEAD** | Sin body | `getResponseBody` falla — pon `bodySize: 0` en el HAR entry |

**Docs:** [chrome-har](https://github.com/sitespeedio/chrome-har) · [HAR 1.2 spec](http://www.softwareishard.com/blog/har-12-spec/) · [requestServedFromCache](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestServedFromCache)

---

## 9. Patrones JS/JSDoc

### `async addTarget()` tiene que ser async de verdad

El framework hace `await collector.addTarget(...)`. Si la función no es `async` o no devuelve la promesa, el framework continúa sin esperar y te pierdes todo.

```javascript
// ❌ Devuelve undefined — el framework no espera nada
addTarget(session, targetInfo) {
  session.send('Network.enable', {}).then(() => { /* tarde */ });
}

// ✅ El framework espera a que todo esté listo
async addTarget(session, targetInfo) {
  await session.send('Network.enable', {});
}
```

### Closure sobre `session` en un loop — por qué funciona

```javascript
for (const session of sessions) {
  session.on('Network.loadingFinished', async (event) => {
    await session.send('Network.getResponseBody', { requestId: event.requestId });
    //    ↑ captura la `session` de ESTA iteración, no una variable compartida
  });
}
```

`for...of` con `const` crea un binding nuevo por iteración. Cada closure captura su propia `session`. No es el bug clásico de `var` donde todos los closures comparten la misma variable.

### `Set<Promise>` para tracking de trabajo en vuelo

```javascript
this._inFlight = new Set();

const p = fetchBody(session, event);
this._inFlight.add(p);
p.finally(() => this._inFlight.delete(p)); // se limpia solo, no leakea

// En getData():
await Promise.allSettled([...this._inFlight]);
```

### Imports de tipos JSDoc entre paquetes

```javascript
/**
 * @param {import('puppeteer-core').CDPSession} session
 * @param {import('devtools-protocol/types/protocol').Protocol.Target.TargetInfo} targetInfo
 */
async addTarget(session, targetInfo) { ... }
```

No necesitas `tsconfig.json`. VS Code resuelve los tipos directamente desde los `.d.ts` de cada paquete.

### `@typedef` va antes de donde se usa

JSDoc no hace hoisting. Si pones el `@typedef` después de la función que lo referencia, el type checker no lo encontrará.

### `?.()` para loggers opcionales

```javascript
this._log?.('mensaje');  // no lanza TypeError si _log es undefined
```

Úsalo cuando el logger es genuinamente opcional. Si es obligatorio, llámalo directamente para que falle con un error claro.

**Docs:** [Optional chaining](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining) · [JSDoc @typedef](https://jsdoc.app/tags-typedef) · [TypeScript JSDoc](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)

---

*Generado con Claude Sonnet 4.6 (`claude-sonnet-4-6`) — Anthropic*