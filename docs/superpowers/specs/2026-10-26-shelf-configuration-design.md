# Configuración persistente de estantería

**Estado:** diseño pendiente de aprobación  
**Fecha:** 2026-10-26

## Intención

Permitir que la persona administradora defina la capacidad física de la única
estantería de almacenamiento. La configuración se guardará en Firebase
Realtime Database y se reutilizará en el formulario de cajas y en el mapa de
ubicación física.

## Objetivos

- Añadir una tarjeta en Configuración para guardar filas y columnas.
- Persistir una única configuración compartida en Firebase.
- Limitar ambos valores a enteros de 1 a 10.
- Hacer que los selectores de fila y columna de las cajas reflejen la
  configuración guardada.
- Validar en el backend que la posición de una caja esté dentro de la
  configuración actual.
- Dibujar la vista física con el número configurado de filas y columnas.
- Impedir reducir la estantería si una caja existente quedaría fuera de ella.

## No objetivos

- No se crearán varias estanterías, zonas o configuraciones por usuario.
- No se moverán automáticamente las cajas que impidan reducir el tamaño.
- No se impedirá que varias cajas ocupen la misma celda; el requisito solo
  define límites de filas y columnas.
- No se modificarán cajas ya almacenadas salvo que se editen.

## Situación actual

La aplicación usa valores fijos de 5 filas y 6 columnas en el componente y
plantilla de almacenamiento, en el validador de cajas y en el CSS del mapa.
El backend ya usa Firebase Realtime Database para `storageBoxes`, pero no hay
un recurso ni rutas para la configuración de estantería.

## Alternativas consideradas

1. **Configuración local del navegador.** Es simple, pero no cumple el
   requisito de guardarla en base de datos ni se comparte entre dispositivos.
   Descartada.
2. **Valores fijos en código.** Mantiene el estado actual, pero exige desplegar
   para cada cambio. Descartada.
3. **Registro único en Firebase consumido mediante API.** Mantiene una fuente
   de verdad común para backend y frontend y encaja con la arquitectura actual.
   **Seleccionada.**

## Diseño

### Datos y API

Se almacenará una configuración global en Firebase bajo `shelfConfig`:

```json
{
  "rows": 5,
  "columns": 6
}
```

La API añadirá el recurso singular `/api/shelf-config`:

| Método | Respuesta | Comportamiento |
| --- | --- | --- |
| `GET /api/shelf-config` | `200 { rows, columns }` | Devuelve la configuración guardada o el valor por defecto 5×6 cuando aún no existe. |
| `PUT /api/shelf-config` | `200 { rows, columns }` | Valida enteros de 1 a 10, bloquea una reducción incompatible y persiste la nueva configuración. |

El backend incorporará un validador, servicio, controlador y router de
estantería, y registrará el router en `src/app.js`. La configuración no tendrá
identificador porque existe una sola estantería global.

Al actualizarla, el servicio leerá las cajas existentes. Si una caja tiene
`shelfRow > rows` o `shelfColumn > columns`, responderá con `409 Conflict` y
un mensaje que indique que debe recolocarse antes. Así no se ocultan cajas ni
se dejan posiciones inválidas tras reducir la capacidad.

### Validación de cajas

Antes de crear o actualizar una caja, el controlador cargará la configuración
actual y la pasará a la validación de posición. El validador dejará de usar los
límites estáticos 5 y 6 y aplicará el rango recibido. La API seguirá rechazando
valores no enteros, menores que uno o mayores que las filas o columnas actuales,
aunque se invoque fuera de la interfaz.

Si todavía no hay configuración en Firebase, se aplicará el valor por defecto
5×6, conservando la compatibilidad con cajas existentes.

### Frontend y experiencia de usuario

Se añadirá un modelo `ShelfConfig` y un servicio Angular con señales para el
valor actual, carga, guardado y error. `ToolApiService` tendrá métodos para el
`GET` y `PUT` de la nueva API.

Configuración mostrará una tarjeta **Estantería de almacenamiento** con dos
controles numéricos, Filas y Columnas, ambos entre 1 y 10. La tarjeta carga la
configuración al entrar, muestra los errores del backend y deshabilita el botón
durante el guardado.

Almacenamiento cargará el mismo servicio. En vez de listas fijas, generará las
opciones de los selectores con señales calculadas para `1..rows` y
`1..columns`. El formulario impedirá valores menores que uno y el backend
mantendrá los límites definitivos.

El mapa físico usará esas mismas listas para cabeceras y celdas. La cantidad de
columnas se expondrá al CSS mediante una variable personalizada y
`grid-template-columns` usará `repeat(var(--shelf-column-count), ...)` en
escritorio y móvil. Con 2 filas y 2 columnas se renderizarán dos cabeceras de
columna y cuatro celdas. En pantallas estrechas se conserva el desplazamiento
horizontal para estanterías anchas.

### Errores y estados límite

- Si falla la lectura, la interfaz mantiene el valor por defecto 5×6 y muestra
  el error del servicio.
- Si falla el guardado, se conserva el formulario y se muestra el mensaje del
  backend.
- Configuración inexistente o antigua: se normaliza a 5 filas y 6 columnas.
- Reducción incompatible: no se persiste ningún cambio y se devuelve `409`.
- Datos corruptos externos: el backend impedirá crear o actualizar nuevas
  posiciones fuera de rango.

## Archivos previstos

- Backend: validador, servicio, controlador y rutas de estantería; registro en
  `src/app.js`; actualización de la validación de cajas; pruebas unitarias y
  de rutas.
- Frontend: modelo y servicio de configuración; métodos HTTP en
  `tool-api.service.ts`; tarjeta de Configuración; sustitución de filas y
  columnas fijas en `storage-page.component.ts`, HTML y SCSS.
- Pruebas: validación 1–10, valores por defecto, persistencia, rechazo de una
  reducción incompatible, límites dinámicos de cajas y compilación Angular.

## Decisiones confirmadas

- Hay una sola estantería global.
- El máximo es 10 filas y 10 columnas.
- Los valores por defecto son 5 filas y 6 columnas.
- Reducir la estantería se bloquea mientras haya una caja fuera del nuevo
  rango.

