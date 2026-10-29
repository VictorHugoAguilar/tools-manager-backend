# Tool Management Backend

Backend API para gestionar herramientas con Firebase Realtime Database y estas propiedades:

- `id`
- `name`
- `type`
- `category`
- `description`
- `urlSrc`
- `state`
- `material`
- `long`

## Requisitos

- Node.js 18 o superior
- Proyecto Firebase con Realtime Database

## Instalacion

```bash
npm install
```

Crea tu archivo `.env` a partir de `.env.example` y configura la conexion:

```bash
cp .env.example .env
```

Variables disponibles:

- `PORT`: puerto del servidor
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`

## Ejecucion

```bash
npm start
```

Modo desarrollo:

```bash
npm run dev
```

Para ejecutar los tests unitarios:

```bash
npm test
```

Si quieres subir el contenido actual de `data/tools.json` a Firebase:

```bash
npm run migrate:firebase
```

La API quedara disponible en:

`http://localhost:3000`

Ejemplo de configuracion:

```env
PORT=3000
FIREBASE_API_KEY=AIzaSyBdvNGddAvCjnOSJPv9KAzwkvkLaMeu7ok
FIREBASE_AUTH_DOMAIN=la-herreria-dev.firebaseapp.com
FIREBASE_DATABASE_URL=https://la-herreria-dev-default-rtdb.europe-west1.firebasedatabase.app
FIREBASE_PROJECT_ID=la-herreria-dev
FIREBASE_STORAGE_BUCKET=la-herreria-dev.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=968683705447
FIREBASE_APP_ID=1:968683705447:web:a0bf87a911e32d190370c2
```

La aplicacion guarda las herramientas en el nodo `tools` de Realtime Database.
Las imagenes se suben a Firebase Storage en la carpeta `tools/<toolId>/`.

## Endpoints

### Obtener todas las herramientas

```http
GET /api/tools
```

Tambien puedes buscar por diferentes criterios usando query params:

```http
GET /api/tools?name=taladro
GET /api/tools?type=electrica&state=disponible
GET /api/tools?category=construccion&material=acero
GET /api/tools?description=pared
GET /api/tools?q=martillo&minLong=20&maxLong=40
GET /api/tools?sortBy=name&sortOrder=asc
GET /api/tools?page=1&limit=5
GET /api/tools?state=disponible&sortBy=long&sortOrder=desc&page=1&limit=10
```

Si usas paginacion, la respuesta devuelve:

```json
{
  "items": [],
  "meta": {
    "totalItems": 0,
    "totalPages": 0,
    "currentPage": 1,
    "limit": 10,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

### Obtener una herramienta por ID

```http
GET /api/tools/:id
```

### Crear una herramienta

```http
POST /api/tools
Content-Type: application/json
```

Ejemplo de body:

```json
{
  "name": "Taladro percutor",
  "type": "Electrica",
  "category": "Construccion",
  "description": "Taladro con percutor para pared y hormigon",
  "urlSrc": "https://example.com/taladro.jpg",
  "state": "Disponible",
  "material": "Acero",
  "long": 32.5
}
```

### Actualizar una herramienta

```http
PUT /api/tools/:id
Content-Type: application/json
```

### Cambiar solo el estado de una herramienta

```http
PATCH /api/tools/:id/state
Content-Type: application/json
```

Ejemplo de body:

```json
{
  "state": "Prestada"
}
```

### Subir o reemplazar la imagen de una herramienta

```http
POST /api/tools/:id/image
Content-Type: multipart/form-data
```

El campo del formulario debe llamarse `image`.

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:3000/api/tools/TOOL_ID/image \
  -F "image=@/ruta/a/imagen.jpg"
```

La API actualiza automaticamente `urlSrc` con la URL publica devuelta por Firebase Storage.

### Eliminar la imagen de una herramienta

```http
DELETE /api/tools/:id/image
```

Ejemplo con `curl`:

```bash
curl -X DELETE http://localhost:3000/api/tools/TOOL_ID/image
```

La API limpia `urlSrc` y, si la imagen estaba en Firebase Storage, elimina tambien el archivo.

### Eliminar una herramienta

```http
DELETE /api/tools/:id
```

## Almacenamiento del taller

Este módulo es independiente del almacenamiento de cajas existente. Usa el nuevo nodo
`workshopStorage` de Realtime Database, organizado en colecciones separadas:

- `workshopStorage/shelves`
- `workshopStorage/levels`
- `workshopStorage/organizers`
- `workshopStorage/compartments`
- `workshopStorage/materials`

Realtime Database no usa tablas SQL; estas colecciones son los nuevos conjuntos de datos
del módulo. Los materiales apuntan a compartimentos y las ubicaciones se resuelven mediante
las relaciones compartimento → organizador → balda → estantería. Por ello, recolocar un
organizador no modifica el inventario.

La API nueva está bajo `/api/workshop-storage`:

- `GET /` devuelve la configuración y el inventario.
- `GET /search?q=...` busca por nombre, categoría y características técnicas.
- Para cada colección (`shelves`, `levels`, `organizers`, `compartments`, `materials`):
  `POST /<colección>`, `PUT /<colección>/:id` y `DELETE /<colección>/:id`.
- `POST /materials/:id/image` sube o reemplaza la fotografía del material.

Las eliminaciones de estructura con elementos dependientes se rechazan para evitar perder
referencias o inventario. Hay que retirar o recolocar primero los elementos dependientes.
Las medidas de ancho y fondo de baldas y organizadores son opcionales; cuando se indican
ambas, la API comprueba que el organizador quepa, permitiendo girarlo 90 grados.

Las categorías editables de los materiales se guardan por separado en
`workshopStorageSettings/materialCategories`. Se pueden consultar con
`GET /api/workshop-storage/categories`, crear con `POST /api/workshop-storage/categories`
(`{ "name": "Adhesivos" }`) y eliminar con
`DELETE /api/workshop-storage/categories/:id`. La primera configuración ofrece Tornillos,
Tuercas, Arandelas, Tacos, Piezas eléctricas y Otros. Retirar una opción no modifica los
materiales ya registrados con esa categoría.
