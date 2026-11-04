# Módulo Dibujar

## Arquitectura

El módulo es independiente y utiliza el sistema actual de sesión/CSRF. La API está montada bajo `/api/drawing`; todos sus endpoints requieren una sesión válida y el permiso global `app:access`. La primera versión mantiene cada pizarra privada para su propietario.

La persistencia usa Firebase Realtime Database y Firebase Storage, que son los servicios configurados por esta aplicación. No se crean tablas SQL ni se duplica el sistema de usuarios.

Los datos nuevos se guardan bajo el nodo `drawing/`:

- `documents`, `documentsByOwner`: metadatos de pizarras y su índice de propietario.
- `pages`, `pagesByDocument`, `pagesByUser`: páginas y sus índices.
- `snapshots`, `versionsByPage`: contenido JSON versionado e historial.
- `preferences`: cámara, fondo, cuadrícula y ajuste por página/usuario.
- `assets`, `assetsByDocument`: metadatos de imágenes y su índice.

El propietario se deriva de la sesión autenticada. Las pizarras se eliminan lógicamente; la eliminación de una imagen la marca como eliminada y borra su objeto de Storage.

## API disponible

- `GET|POST /documents`
- `GET|PATCH|DELETE /documents/:documentId`
- `POST /documents/:documentId/{duplicate,archive,restore}`
- `GET|POST /documents/:documentId/pages`
- `PATCH /documents/:documentId/pages/reorder`
- `GET|PATCH|DELETE /pages/:pageId`
- `POST /pages/:pageId/duplicate`
- `GET|PUT /pages/:pageId/snapshot`
- `GET /pages/:pageId/versions`
- `GET /pages/:pageId/versions/:version`
- `POST /pages/:pageId/versions/:version/restore`
- `GET|PUT /pages/:pageId/preferences`
- `POST /documents/:documentId/assets`
- `GET|DELETE /assets/:assetId`

Los guardados de snapshot requieren `schemaVersion: 1` y `expectedVersion`. La versión se compara dentro de una transacción de Firebase; los conflictos devuelven HTTP 409. Se limita el snapshot a 750 KiB y 2.500 objetos. El contenido debe ajustarse al esquema de objetos del adaptador del lienzo. Al leer snapshots, la API normaliza las colecciones que Realtime Database devuelve como mapas con claves numéricas (incluidas las colecciones vacías) al formato de array esperado por el editor. Si Firebase omite el cuerpo vacío, la API solo lo reconstruye cuando el hash persistido coincide con el de `{ objects: [] }`.

Los recursos se almacenan fuera del snapshot. La primera versión admite PNG, JPEG y WebP hasta 10 MB, verifica las firmas binarias y entrega las descargas a través de un endpoint autenticado que comprueba la propiedad de la pizarra.

## Alcance actual y pendientes

El frontend incluye biblioteca privada, editor Konva, formas básicas, texto, dibujo libre, selección/movimiento/redimensionado, borrado de objetos, zoom/pan, cuadrícula, autosave con control de versión, páginas, historial, importación JSON y exportación JSON/PNG.

No forman parte de esta primera entrega: compartir pizarras, colaboración en tiempo real, SVG/PDF, plantillas, miniaturas persistidas, colocación de imágenes dentro del lienzo, selección múltiple/agrupación/alineación, conectores anclados, capas avanzadas ni recuperación offline. El backend de recursos está preparado para imágenes rasterizadas, pero la interfaz todavía no inserta imágenes en el lienzo. No se debe presentar la función de recursos como una función completa del editor hasta integrar esa interfaz.

El SDK Konva está bajo licencia MIT. El SDK tldraw no se utiliza, por lo que su licencia comercial no es aplicable.
