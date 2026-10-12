/**
 * Endpoint de Shopify para el dashboard de ventas (Google Apps Script, implementado como app web).
 *
 * Devuelve:
 *   {
 *     generado: ISO,
 *     mensual:  [{mes:'2026-01', ordenes, total, neto}]   // historial completo vía ShopifyQL
 *     ordenes:  [{id, fecha, total, moneda, cliente, productos, estado}]  // últimas 50, sin email
 *     errores:  [texto]                                     // si alguna parte falló
 *   }
 *
 * Por qué ShopifyQL: la API de órdenes solo entrega los últimos 60 días si la app no tiene el
 * permiso read_all_orders. ShopifyQL (permiso read_reports) devuelve los totales de todo el historial,
 * los mismos que muestra Shopify Admin → Analytics.
 *
 * Configuración (Configuración del proyecto → Propiedades del script):
 *   SHOPIFY_SHOP   tienda.myshopify.com
 *   SHOPIFY_TOKEN  token de Admin API de la app personalizada, con permisos:
 *                  read_orders, read_reports (y read_customers para el nombre del cliente)
 */
const API_VERSION = '2025-10';
const DESDE = '2019-01-01';
const TZ = 'America/Costa_Rica';

function doGet() {
  const out = { generado: new Date().toISOString(), mensual: null, ordenes: [], errores: [] };
  try { out.mensual = ventasMensuales_(); } catch (e) { out.errores.push('mensual: ' + e.message); }
  try { out.ordenes = ordenesRecientes_(); } catch (e) { out.errores.push('ordenes: ' + e.message); }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function gql_(query, variables) {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(
    'https://' + props.getProperty('SHOPIFY_SHOP') + '/admin/api/' + API_VERSION + '/graphql.json',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': props.getProperty('SHOPIFY_TOKEN') },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true,
    }
  );
  const json = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || json.errors) throw new Error(JSON.stringify(json.errors || res.getContentText()).slice(0, 300));
  return json.data;
}

function ventasMensuales_() {
  const q = 'query($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name } rows } } }';
  const shopifyql = 'FROM sales SHOW orders, total_sales, net_sales GROUP BY month SINCE ' + DESDE + ' UNTIL today ORDER BY month';
  const res = gql_(q, { q: shopifyql }).shopifyqlQuery;
  if (res.parseErrors && res.parseErrors.length) throw new Error(res.parseErrors.join('; '));
  const cols = res.tableData.columns.map(function (c) { return c.name; });
  return res.tableData.rows.map(function (r) {
    // Las filas pueden venir como objeto {month, orders, ...} o como arreglo en el orden de columns
    const row = Array.isArray(r) ? cols.reduce(function (o, c, i) { o[c] = r[i]; return o; }, {}) : r;
    return {
      mes: String(row.month).slice(0, 7),
      ordenes: Number(row.orders) || 0,
      total: Number(row.total_sales) || 0,
      neto: Number(row.net_sales) || 0,
    };
  }).filter(function (m) { return m.ordenes || m.total; });
}

function ordenesRecientes_() {
  const q = '{ orders(first: 50, sortKey: CREATED_AT, reverse: true) { nodes {' +
    ' legacyResourceId createdAt displayFinancialStatus' +
    ' totalPriceSet { shopMoney { amount currencyCode } }' +
    ' customer { displayName }' +
    ' lineItems(first: 10) { nodes { title } } } } }';
  return gql_(q).orders.nodes.map(function (o) {
    return {
      id: o.legacyResourceId,
      fecha: Utilities.formatDate(new Date(o.createdAt), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      total: o.totalPriceSet.shopMoney.amount,
      moneda: o.totalPriceSet.shopMoney.currencyCode,
      cliente: o.customer ? o.customer.displayName : '',
      productos: o.lineItems.nodes.map(function (li) { return li.title; }).join(', '),
      estado: String(o.displayFinancialStatus || '').toLowerCase(),
    };
  });
}
