# Configuración de estantería Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistir una configuración única de estantería y usarla como límite y visualización dinámica para las cajas de almacenamiento.

**Architecture:** El backend añadirá un recurso singleton `/api/shelf-config` respaldado por Firebase Realtime Database. El controlador de cajas consultará esa misma configuración antes de validar altas o modificaciones. En Angular, un servicio singleton cargará y guardará la configuración para que Configuración, el formulario de cajas y el mapa físico consuman la misma señal reactiva.

**Tech Stack:** Node.js, Express, Firebase Realtime Database, Node test runner, Angular 21, Signals, Reactive Forms, RxJS, SCSS.

**Spec:** `docs/superpowers/specs/2026-10-26-shelf-configuration-design.md`

## Global Constraints

- Existe una sola estantería global, almacenada en Firebase bajo `shelfConfig`.
- Filas y columnas son enteros entre **1** y **10**, inclusive.
- Cuando no exista configuración persistida, el valor por defecto es **5 filas × 6 columnas**.
- Reducir dimensiones se bloquea con `409 Conflict` si alguna caja existente queda fuera del nuevo rango.
- No se crean varias estanterías, no se recolocan cajas automáticamente y no se impide compartir una misma celda.
- El backend mantiene la validación definitiva, aunque el cliente restrinja las opciones.
- No se añadirán dependencias nuevas ni infraestructura de pruebas de Angular; el proyecto frontend actual se verifica mediante `npm run build`.
- Como el frontend no dispone de un ejecutor de pruebas configurado, las tareas de interfaz parten de una compilación base y se validan mediante comprobación de tipos, build de Angular y la verificación manual de la Tarea 6; las reglas de negocio sí se cubren con pruebas backend antes de implementarlas.

## Review Focus

- Configuración ausente o corrupta: la API y la UI deben usar 5×6 sin dejar selectores ni validadores sin límite; se prueba en la **Tarea 1**.
- Límites 1 y 10: cero, decimales y 11 deben rechazarse; se prueba en la **Tarea 1**.
- Reducción con cajas fuera de rango: no debe escribirse una configuración incompatible y debe devolverse 409; se prueba en la **Tarea 1** y la **Tarea 2**.
- Alta o edición de caja mediante API directa: una fila o columna fuera de la configuración actual debe recibir 400; se prueba en la **Tarea 2**.
- Configuración 2×2 en la vista: selectores, texto y CSS deben formar exactamente una cuadrícula de dos columnas y dos filas; se comprueba por compilación y revisión del enlace de plantilla en la **Tarea 5**.

---

## Estructura de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `src/validators/shelfConfigValidator.js` | Constantes compartidas, normalización de datos persistidos y validación estricta del payload 1–10. |
| `src/services/shelfConfigService.js` | Leer y guardar `shelfConfig` en Firebase; detectar cajas que impedirían reducir dimensiones. |
| `src/controllers/shelfConfigController.js` | Traducir la validación y los conflictos del servicio a respuestas HTTP. |
| `src/routes/shelfConfigRoutes.js` | Exponer `GET /` y `PUT /` para el recurso singleton. |
| `src/app.js` | Registrar `/api/shelf-config` y documentar los endpoints raíz. |
| `src/validators/storageBoxValidator.js` | Reemplazar máximos fijos por límites que recibe del controlador. |
| `src/controllers/storageBoxController.js` | Cargar la configuración actual antes de validar creación o edición de una caja. |
| `test/validators/shelfConfigValidator.test.js` | Cobertura de normalización y límites 1–10. |
| `test/services/shelfConfigService.test.js` | Cobertura Firebase simulada, persistencia y conflicto de reducción. |
| `test/controllers/shelfConfigController.test.js` | Cobertura de respuestas 200, 400 y 409. |
| `test/controllers/storageBoxController.test.js` | Prueba de que el controlador de cajas pasa los límites cargados al validador. |
| `test/validators/storageBoxValidator.test.js` | Prueba de límites dinámicos para filas y columnas. |
| `test/app.test.js` | Verificación del montaje de la nueva ruta. |
| `frontend/src/app/models/shelf-config.model.ts` | Interfaces y valores por defecto compartidos por el frontend. |
| `frontend/src/app/services/shelf-config.service.ts` | Estado signal de carga/guardado/error y acceso a `ToolApiService`. |
| `frontend/src/app/services/tool-api.service.ts` | Métodos HTTP para obtener y actualizar la configuración. |
| `frontend/src/app/pages/settings/*` | Card, formulario y estilos de configuración de estantería. |
| `frontend/src/app/pages/storage/*` | Opciones de ubicación, validadores y mapa dinámicos. |

### Task 1: Dominio y persistencia de configuración de estantería

**Files:**
- Create: `src/validators/shelfConfigValidator.js`
- Create: `src/services/shelfConfigService.js`
- Create: `test/validators/shelfConfigValidator.test.js`
- Create: `test/services/shelfConfigService.test.js`

**Interfaces:**
- Produces: `DEFAULT_SHELF_CONFIG = { rows: 5, columns: 6 }`, `MAX_SHELF_DIMENSION = 10`, `validateShelfConfigPayload(payload)`, `normalizeStoredShelfConfig(value)`.
- Produces: `getShelfConfig(): Promise<{ rows: number, columns: number }>` and `updateShelfConfig(config): Promise<{ rows: number, columns: number }>`.
- Produces: `ShelfConfigConflictError` with `code === 'SHELF_CONFIG_CONFLICT'`, consumed by Task 2.

- [ ] **Step 1: Write failing validator tests for normalización, límites inclusivos y valores inválidos**

```js
test("validateShelfConfigPayload accepts the 1 to 10 boundaries", () => {
    assert.deepEqual(validateShelfConfigPayload({ rows: 1, columns: 10 }), {
        isValid: true,
        errors: [],
        data: { rows: 1, columns: 10 }
    });
});

test("validateShelfConfigPayload rejects zero, decimals and dimensions over 10", () => {
    const result = validateShelfConfigPayload({ rows: 0, columns: 10.5 });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((error) => error.includes("rows")));
    assert.ok(result.errors.some((error) => error.includes("columns")));
});
```

Also add a test that `normalizeStoredShelfConfig(undefined)` returns `{ rows: 5, columns: 6 }` and invalid stored data falls back safely.

- [ ] **Step 2: Run the validator test to verify it fails**

Run: `npm test -- test/validators/shelfConfigValidator.test.js`  
Expected: FAIL because the validator module does not exist.

- [ ] **Step 3: Implement the strict payload validator and stored-value normalizer**

In `src/validators/shelfConfigValidator.js`, export `DEFAULT_SHELF_CONFIG`, `MAX_SHELF_DIMENSION`, `validateShelfConfigPayload(payload)`, and `normalizeStoredShelfConfig(value)`. The payload validator must require an object with integer `rows` and `columns`, both in the inclusive 1–10 range. The stored-value normalizer must return a clone of the default for missing, malformed, or out-of-range Firebase data.

- [ ] **Step 4: Run the validator test to verify it passes**

Run: `npm test -- test/validators/shelfConfigValidator.test.js`  
Expected: PASS.

- [ ] **Step 5: Write failing service tests for default loading, persistence, and incompatibility**

Build a Firebase mock using the existing `loadModuleWithMocks` approach. Cover:
1. missing `shelfConfig` returns the default 5×6;
2. saving `{ rows: 4, columns: 3 }` writes exactly to `shelfConfig`;
3. a box at row 5 prevents saving 4 rows;
4. a box at column 6 prevents saving 5 columns;
5. a compatible resize writes the config.

Assert that incompatible saves reject with `code === 'SHELF_CONFIG_CONFLICT'` and do not call Firebase `set`.

- [ ] **Step 6: Run the service test to verify it fails**

Run: `npm test -- test/services/shelfConfigService.test.js`  
Expected: FAIL because the service module does not exist.

- [ ] **Step 7: Implement `getShelfConfig()` and `updateShelfConfig(config)`**

In `src/services/shelfConfigService.js`, use `getDatabaseInstance()`, `get(ref(database, 'shelfConfig'))`, and `set(ref(database, 'shelfConfig'), config)`. Before a write, read `storageBoxes` and inspect all stored boxes; throw `ShelfConfigConflictError` when any `shelfRow` or `shelfColumn` exceeds the proposed dimension. Ignore missing/invalid legacy position fields by treating their effective position as 1.

- [ ] **Step 8: Run the service test to verify it passes**

Run: `npm test -- test/services/shelfConfigService.test.js`  
Expected: PASS.

- [ ] **Step 9: Commit the backend configuration domain**

```bash
git add src/validators/shelfConfigValidator.js src/services/shelfConfigService.js \
  test/validators/shelfConfigValidator.test.js test/services/shelfConfigService.test.js
git commit -m "feat: add persisted shelf configuration domain"
```

### Task 2: Rutas HTTP y límites dinámicos para cajas

**Files:**
- Create: `src/controllers/shelfConfigController.js`
- Create: `src/routes/shelfConfigRoutes.js`
- Create: `test/controllers/shelfConfigController.test.js`
- Create: `test/controllers/storageBoxController.test.js`
- Modify: `src/app.js`
- Modify: `src/validators/storageBoxValidator.js`
- Modify: `src/controllers/storageBoxController.js`
- Modify: `test/validators/storageBoxValidator.test.js`
- Modify: `test/app.test.js`

**Interfaces:**
- Consumes: `validateShelfConfigPayload(payload)`, `getShelfConfig()`, `updateShelfConfig(config)`, and `ShelfConfigConflictError` from Task 1.
- Produces: `getShelfConfig(_req, res)` and `updateShelfConfig(req, res)`.
- Produces: `validateStorageBoxPayload(payload, { requireCode, shelfConfig })`, where `shelfConfig` is `{ rows, columns }`.

- [ ] **Step 1: Write failing controller and route-registration tests**

Add controller tests with the existing mock-harness pattern:
- GET returns `200` and the config supplied by the service;
- invalid PUT returns `400 { message: 'Validation error', errors }`;
- compatible PUT returns `200`;
- a service rejection carrying `SHELF_CONFIG_CONFLICT` returns `409` with its actionable message.

Extend `test/app.test.js` to assert that a router is mounted at `/api/shelf-config`.

- [ ] **Step 2: Run the new controller and app tests to verify they fail**

Run: `npm test -- test/controllers/shelfConfigController.test.js test/app.test.js`  
Expected: FAIL because the controller and route are not registered.

- [ ] **Step 3: Implement singleton controller, router, and application registration**

Create a router with `GET '/'` and `PUT '/'`. In the controller, validate before invoking the service. Map `SHELF_CONFIG_CONFLICT` to status 409; unexpected errors follow the existing 500 response convention. Register it in `src/app.js` at `/api/shelf-config` and add both methods to the root endpoint documentation.

- [ ] **Step 4: Run the controller and app tests to verify they pass**

Run: `npm test -- test/controllers/shelfConfigController.test.js test/app.test.js`  
Expected: PASS.

- [ ] **Step 5: Write failing dynamic box-bound tests**

Extend `test/validators/storageBoxValidator.test.js` with a valid box at `F2-C2` under `{ rows: 2, columns: 2 }`, then assert that row 3 and column 3 are rejected. Add a controller harness test that `createStorageBox` and `updateStorageBox` call the validator with the configuration returned by `getShelfConfig()`.

- [ ] **Step 6: Run dynamic box-bound tests to verify they fail**

Run: `npm test -- test/validators/storageBoxValidator.test.js test/controllers/storageBoxController.test.js`  
Expected: FAIL because the validator still uses 5×6 and the controller does not load the configuration.

- [ ] **Step 7: Make box validation depend on the persisted configuration**

Modify `validateStorageBoxPayload(payload, options = {})` to use `normalizeStoredShelfConfig(options.shelfConfig)` for its maximum row and column rather than module-level 5 and 6 constants. In `createStorageBox` and `updateStorageBox`, await `getShelfConfig()` before calling the validator and pass it as `shelfConfig`. Keep every existing field validation and response shape unchanged.

- [ ] **Step 8: Run dynamic box-bound tests to verify they pass**

Run: `npm test -- test/validators/storageBoxValidator.test.js test/controllers/storageBoxController.test.js`  
Expected: PASS.

- [ ] **Step 9: Run the complete backend suite**

Run: `npm test`  
Expected: PASS with all existing and new tests.

- [ ] **Step 10: Commit HTTP integration and dynamic box validation**

```bash
git add src/app.js src/controllers/shelfConfigController.js src/routes/shelfConfigRoutes.js \
  src/controllers/storageBoxController.js src/validators/storageBoxValidator.js \
  test/controllers/shelfConfigController.test.js test/controllers/storageBoxController.test.js \
  test/validators/storageBoxValidator.test.js test/app.test.js
git commit -m "feat: enforce shelf configuration for boxes"
```

### Task 3: Cliente Angular para configuración de estantería

**Files:**
- Create: `frontend/src/app/models/shelf-config.model.ts`
- Create: `frontend/src/app/services/shelf-config.service.ts`
- Modify: `frontend/src/app/services/tool-api.service.ts`

**Interfaces:**
- Consumes: `GET /api/shelf-config` and `PUT /api/shelf-config`.
- Produces: `ShelfConfig`, `ShelfConfigPayload`, `DEFAULT_SHELF_CONFIG`, and `ShelfConfigService`.
- Produces: `currentConfig: Signal<ShelfConfig>`, `loading: Signal<boolean>`, `saving: Signal<boolean>`, `error: Signal<string | null>`, `ensureLoaded(): void`, and `saveConfig(payload: ShelfConfigPayload): Promise<ShelfConfig>`.

- [ ] **Step 1: Add the typed frontend model and failing compile references**

Create `shelf-config.model.ts` with:
```ts
export interface ShelfConfig { rows: number; columns: number; }
export type ShelfConfigPayload = ShelfConfig;
export const DEFAULT_SHELF_CONFIG: ShelfConfig = { rows: 5, columns: 6 };
```
Add temporary typed calls in the service implementation skeleton that require `ToolApiService.getShelfConfig()` and `ToolApiService.updateShelfConfig(payload)`.

- [ ] **Step 2: Run TypeScript compilation to verify the API methods are missing**

Run: `npx tsc --noEmit --project tsconfig.app.json` from `frontend/`  
Expected: FAIL with missing `getShelfConfig` and `updateShelfConfig` members.

- [ ] **Step 3: Add typed HTTP methods and the signal-backed store**

Add `shelfConfigUrl = environment.apiUrl + '/api/shelf-config'` to `ToolApiService` and implement:
```ts
getShelfConfig(): Observable<ShelfConfig>
updateShelfConfig(payload: ShelfConfigPayload): Observable<ShelfConfig>
```

Implement `ShelfConfigService` using `firstValueFrom` and `finalize`, following the existing store-service error extraction style. Initialize `currentConfig` with `DEFAULT_SHELF_CONFIG`, avoid duplicate loads in `ensureLoaded()`, replace the signal on successful GET/PUT, and preserve the fallback plus an error signal on failed GET.

- [ ] **Step 4: Run TypeScript compilation to verify it passes**

Run: `npx tsc --noEmit --project tsconfig.app.json` from `frontend/`  
Expected: PASS.

- [ ] **Step 5: Commit the frontend configuration client**

```bash
git add frontend/src/app/models/shelf-config.model.ts \
  frontend/src/app/services/shelf-config.service.ts \
  frontend/src/app/services/tool-api.service.ts
git commit -m "feat: add shelf configuration client"
```

### Task 4: Tarjeta de configuración de estantería

**Files:**
- Modify: `frontend/src/app/pages/settings/settings-page.component.ts`
- Modify: `frontend/src/app/pages/settings/settings-page.component.html`
- Modify: `frontend/src/app/pages/settings/settings-page.component.scss`

**Interfaces:**
- Consumes: `ShelfConfigService.currentConfig()`, `.loading()`, `.saving()`, `.error()`, `.ensureLoaded()`, and `.saveConfig(payload)` from Task 3.
- Produces: a settings form whose `rows` and `columns` values are valid 1–10 `number` values.

- [ ] **Step 1: Establish a clean frontend compilation baseline**

Run: `npx tsc --noEmit --project tsconfig.app.json` from `frontend/`  
Expected: PASS after Task 3. There is no Angular unit-test runner configured, so this confirms the typed client is ready for the page integration.

- [ ] **Step 2: Implement form synchronization and save behavior**

In the constructor, call `shelfConfigStore.ensureLoaded()`. Add an effect that patches the form when `currentConfig()` changes without marking it dirty. Implement `saveShelfConfig(): Promise<void>` to mark invalid fields touched or await `saveConfig(this.shelfConfigForm.getRawValue())`. Add field-error helpers that distinguish required, minimum, and maximum failures.

- [ ] **Step 3: Render the Estantería de almacenamiento card**

Add a settings card with:
- numeric inputs for Filas and Columnas, each with `min="1"` and `max="10"`;
- visible loading and API-error states;
- a submit button disabled while `.saving()`;
- copy explaining that reducing the configuration is blocked when a stored box would remain outside it.

Reuse existing `.settings-card`, `.location-form`, `.field-error`, and action styles; add only focused responsive styling required for the two-number control layout.

- [ ] **Step 4: Build the frontend to verify template and styles compile**

Run: `npm run build` from `frontend/`  
Expected: PASS; pre-existing non-blocking bundle/CommonJS warnings may remain.

- [ ] **Step 5: Commit the settings card**

```bash
git add frontend/src/app/pages/settings/settings-page.component.ts \
  frontend/src/app/pages/settings/settings-page.component.html \
  frontend/src/app/pages/settings/settings-page.component.scss
git commit -m "feat: configure shelf dimensions in settings"
```

### Task 5: Formulario y mapa físico dinámicos

**Files:**
- Modify: `frontend/src/app/pages/storage/storage-page.component.ts`
- Modify: `frontend/src/app/pages/storage/storage-page.component.html`
- Modify: `frontend/src/app/pages/storage/storage-page.component.scss`

**Interfaces:**
- Consumes: `ShelfConfigService.currentConfig(): ShelfConfig` from Task 3.
- Produces: `shelfRows(): number[]` and `shelfColumns(): number[]` computed from the loaded configuration.

- [ ] **Step 1: Establish a clean frontend compilation baseline**

Run: `npx tsc --noEmit --project tsconfig.app.json` from `frontend/`  
Expected: PASS after Tasks 3 and 4. This is the pre-change compile baseline for the storage-page integration.

- [ ] **Step 2: Implement dynamic row/column source and validators**

Call `shelfConfigStore.ensureLoaded()` from the component constructor. Define:
```ts
protected readonly shelfRows = computed(() => Array.from(
  { length: this.shelfConfigStore.currentConfig().rows },
  (_, index) => index + 1
));
protected readonly shelfColumns = computed(() => Array.from(
  { length: this.shelfConfigStore.currentConfig().columns },
  (_, index) => index + 1
));
```

Replace static maximum validators with an effect that applies `Validators.max(currentConfig.rows)` and `Validators.max(currentConfig.columns)` to the relevant controls and calls `updateValueAndValidity({ emitEvent: false })`. Preserve the existing default position F1-C1 and edit behavior.

- [ ] **Step 3: Make the storage template consume the configuration**

Update all row and column loops to invoke the computed signals, including box-create/edit selects and map axes/cells. Make the summary sentence report `shelfRows().length` and `shelfColumns().length`. Bind:
```html
[style.--shelf-column-count]="shelfColumns().length"
```
on the map so layout and rendered cells use the same configuration.

- [ ] **Step 4: Replace hard-coded CSS column counts**

Use a fallback `--shelf-column-count: 6` and change desktop and mobile grid definitions to:
```scss
grid-template-columns: 48px repeat(var(--shelf-column-count), minmax(44px, 1fr));
```
Use the existing mobile first-column width with the same custom property. Keep horizontal overflow on narrow screens.

- [ ] **Step 5: Build the frontend and inspect the 2×2 contract**

Run: `npm run build` from `frontend/`  
Expected: PASS. Confirm in the compiled template source that each configured row emits one row label and the configured number of cells, and that `--shelf-column-count` is bound to `shelfColumns().length`.

- [ ] **Step 6: Commit dynamic storage positions and map**

```bash
git add frontend/src/app/pages/storage/storage-page.component.ts \
  frontend/src/app/pages/storage/storage-page.component.html \
  frontend/src/app/pages/storage/storage-page.component.scss
git commit -m "feat: use configured shelf dimensions in storage"
```

### Task 6: End-to-end regression verification

**Files:**
- Modify if necessary: only files identified by failed verification; do not refactor unrelated code.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified API behavior and a production Angular bundle.

- [ ] **Step 1: Run the entire backend regression suite**

Run: `npm test` from the repository root  
Expected: PASS.

- [ ] **Step 2: Run frontend type checking**

Run: `npx tsc --noEmit --project tsconfig.app.json` from `frontend/`  
Expected: PASS.

- [ ] **Step 3: Run the production frontend build**

Run: `npm run build` from `frontend/`  
Expected: PASS. Report any existing bundle-size or CommonJS warnings separately, but do not treat them as feature failures.

- [ ] **Step 4: Manually verify the two essential workflows**

1. Save 2 rows and 2 columns in Configuración, then open a new and an existing box: each selector must only offer 1 and 2.
2. Open a box at F2-C2: the location map must show two row headers, two column headers, four cells, and highlight F2-C2.
3. Attempt to reduce dimensions below any existing box location: settings must retain the form values and display the API conflict message.

- [ ] **Step 5: Commit final verification adjustments**

```bash
git add <only-files-adjusted-during-verification>
git commit -m "test: verify dynamic shelf configuration"
```

