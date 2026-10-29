// ─── Web Bluetooth ESC/POS printer for BTP-802 (and compatible) ───────────────

// Known BLE service/characteristic pairs for common thermal receipt printers
const KNOWN_PAIRS = [
  // BTP-802 / PT-series / many generic printers
  { svc: '000018f0-0000-1000-8000-00805f9b34fb', chr: '00002af1-0000-1000-8000-00805f9b34fb' },
  // Xprinter XP series / HPRT
  { svc: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', chr: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
  // Generic 0xFF00 (most common Chinese printers)
  { svc: '0000ff00-0000-1000-8000-00805f9b34fb', chr: '0000ff02-0000-1000-8000-00805f9b34fb' },
  // Peripage / Paperang style
  { svc: '49535343-fe7d-4ae5-8fa9-9fafd205e455', chr: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
  // SPP-over-BLE variant
  { svc: '00001101-0000-1000-8000-00805f9b34fb', chr: '00001101-0000-1000-8000-00805f9b34fb' },
];

let _device = null;
let _char = null;

export const isBTSupported = () =>
  typeof navigator !== 'undefined' && 'bluetooth' in navigator;

export const isConnected = () =>
  !!(_device?.gatt?.connected && _char);

export const getSavedPrinterName = () =>
  localStorage.getItem('bt_printer_name') || null;

export function disconnect() {
  try { if (_device?.gatt?.connected) _device.gatt.disconnect(); } catch (_) {}
  _device = null;
  _char = null;
  localStorage.removeItem('bt_printer_name');
}

// Connect to printer — shows all nearby BT devices so user can pick the correct printer
export async function connectPrinter() {
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: KNOWN_PAIRS.map((p) => p.svc),
  });

  const server = await device.gatt.connect();
  device.addEventListener('gattserverdisconnected', () => {
    _device = null;
    _char = null;
  });

  // Try each known service/characteristic pair
  for (const { svc, chr } of KNOWN_PAIRS) {
    try {
      const service = await server.getPrimaryService(svc);
      const characteristic = await service.getCharacteristic(chr);
      _device = device;
      _char = characteristic;
      localStorage.setItem('bt_printer_name', device.name || 'Printer');
      return device.name || 'Printer';
    } catch (_) { /* try next pair */ }
  }

  device.gatt.disconnect();
  throw new Error(
    'Could not find a compatible print service on this printer.\n' +
    'Please try again or contact support.'
  );
}

// ─── ESC/POS constants ────────────────────────────────────────────────────────

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

const cmd = {
  init:     () => [ESC, 0x40],
  align:    (a) => [ESC, 0x61, a],          // 0=left 1=center 2=right
  bold:     (on) => [ESC, 0x45, on ? 1 : 0],
  textSize: (w, h) => [GS, 0x21, ((w - 1) << 4) | (h - 1)],
  feed:     (n) => [ESC, 0x64, n],
  cut:      () => [GS, 0x56, 0x42, 0x00],
};

// Encode a string to ESC/POS-safe bytes (₹ → "Rs", non-ASCII → '?')
function encodeText(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0x20b9) { out.push(82, 115); } // ₹ → Rs
    else if (c < 128)  { out.push(c); }
    else               { out.push(63); }      // ? for non-ASCII
  }
  return out;
}

// ─── ESC/POS receipt builder ───────────────────────────────────────────────────
//
// shopInfo mirrors the /api/settings/public response so the Bluetooth
// print always stays in sync with the on-screen receipt.
//
export function buildReceiptBytes(order, shopInfo = {}) {
  // ── Shop settings (with safe fallbacks) ──────────────────────────────────
  const shopName   = shopInfo.shop_name       || 'Balaji Fataka';
  const shopAddr   = shopInfo.address         || '';
  const shopPhone  = shopInfo.phone           || '';
  const gstNo      = shopInfo.gst_no          || '';
  const fireLic    = shopInfo.fire_license_no || '';
  const gstEnabled = shopInfo.gst_enabled     ?? false;
  const upiId      = shopInfo.upi_id          || 'paytm.d95113099@pty';
  const upiName    = shopInfo.upi_name        || shopName;
  const is58mm     = (shopInfo.paper_size     || '80mm') === '58mm';
  const COLS       = is58mm ? 32 : 48;

  // ── Local helpers using dynamic COLS ─────────────────────────────────────
  const _ln    = (t) => [...encodeText(t), LF];
  const _empty = ()  => [LF];
  const _dash  = ()  => _ln('-'.repeat(COLS));
  const _equal = ()  => _ln('='.repeat(COLS));

  const _pad = (left, right) => {
    const maxLeft = COLS - right.length - 1;
    const l = left.length > maxLeft ? left.slice(0, maxLeft) : left;
    const gap = COLS - l.length - right.length;
    return l + (gap > 0 ? ' '.repeat(gap) : ' ') + right;
  };

  const _wrap = (text) => {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + (cur ? ' ' : '') + w).length > COLS) {
        if (cur) lines.push(cur);
        cur = w.slice(0, COLS);
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  // ── Build bytes ───────────────────────────────────────────────────────────
  const bytes = [];
  const push = (...chunks) =>
    chunks.forEach((c) => (Array.isArray(c) ? bytes.push(...c) : bytes.push(c)));

  const dateStr = new Date(order.created_at).toLocaleString('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // Init
  push(cmd.init());

  // ── Shop header ────────────────────────────────────────────────────────────
  push(cmd.align(1), cmd.bold(true), cmd.textSize(2, 2));
  push(_ln(shopName));
  push(cmd.textSize(1, 1), cmd.bold(false));
  if (shopAddr) {
    shopAddr.split('\n').forEach((line) => { if (line.trim()) push(_ln(line.trim())); });
  }
  if (shopPhone) push(_ln('Ph: ' + shopPhone));
  if (gstEnabled && gstNo) push(_ln('GSTIN: ' + gstNo));
  if (fireLic) push(_ln('Explosives Lic: ' + fireLic));
  push(_empty());
  push(cmd.bold(true));
  push(_ln(is58mm ? '===== INVOICE =====' : '========== INVOICE =========='));
  push(cmd.bold(false));
  push(_empty());

  // ── Order info ─────────────────────────────────────────────────────────────
  push(cmd.align(0));
  push(_ln('Inv : ' + order.invoice_no));
  push(_ln('Date: ' + dateStr));
  const custType = order.customer_type === 'wholesale' ? 'Wholesale' : 'Retail';
  push(_ln('Cust: ' + order.customer_name + ' (' + custType + ')'));
  if (order.customer_phone) push(_ln('Ph  : ' + order.customer_phone));
  if (order.salesperson_name) push(_ln('By  : ' + order.salesperson_name));

  push(_dash());

  // ── Items header ───────────────────────────────────────────────────────────
  push(cmd.bold(true));
  push(_ln(_pad('ITEM', 'AMOUNT')));
  push(cmd.bold(false));
  push(_dash());

  // ── Items ──────────────────────────────────────────────────────────────────
  order.items.forEach((it) => {
    const amt       = 'Rs ' + (it.price * it.qty).toFixed(2);
    const nameLines = _wrap(it.name);
    push(_ln(_pad(nameLines[0], amt)));
    nameLines.slice(1).forEach((l) => push(_ln('  ' + l)));
    const hsnSuffix = (gstEnabled && it.hsn) ? '  HSN: ' + it.hsn : '';
    push(_ln('  ' + it.qty + ' x Rs ' + it.price.toFixed(2) + hsnSuffix));
  });

  push(_dash());

  // ── Items count / Total qty ────────────────────────────────────────────────
  const totalQty = order.items.reduce((s, i) => s + i.qty, 0);
  push(_ln('Items ' + order.items.length + ' / Qty ' + totalQty));
  push(_empty());

  // ── Totals ─────────────────────────────────────────────────────────────────
  push(_ln(_pad('Subtotal', 'Rs ' + order.subtotal.toFixed(2))));
  if (order.discount > 0)
    push(_ln(_pad('Discount', '-Rs ' + order.discount.toFixed(2))));
  if (order.cgst > 0) {
    push(_ln(_pad('CGST (9%)', 'Rs ' + order.cgst.toFixed(2))));
    push(_ln(_pad('SGST (9%)', 'Rs ' + order.sgst.toFixed(2))));
  }
  if (order.round_off && order.round_off !== 0)
    push(_ln(_pad('Round off', order.round_off.toFixed(2))));

  push(_equal());
  push(cmd.bold(true), cmd.textSize(1, 2));
  push(_ln(_pad('TOTAL', 'Rs ' + order.total.toFixed(2))));
  push(cmd.textSize(1, 1), cmd.bold(false));
  push(_equal());

  // ── Payment ────────────────────────────────────────────────────────────────
  const modeLabel =
    order.payment_mode === 'upi'  ? 'UPI' :
    order.payment_mode === 'cash' ? 'Cash' : 'Card';
  push(_ln(_pad('Paid by ' + modeLabel, 'Rs ' + order.total.toFixed(2))));
  if (order.utr) push(_ln('UTR: ' + order.utr));
  push(_ln(_pad('Status', order.status === 'paid' ? 'PAID' : 'PENDING')));

  // ── UPI payment section — always printed ──────────────────────────────────
  push(_dash());
  push(cmd.align(1));
  push(cmd.bold(true));
  push(_ln('PAY VIA UPI'));
  push(cmd.bold(false));
  push(_ln(upiId));
  push(_ln('Amt: Rs ' + order.total.toFixed(2)));
  push(_ln('Ref: ' + order.invoice_no));
  push(cmd.align(0));

  push(_dash());

  // ── Footer ─────────────────────────────────────────────────────────────────
  push(cmd.align(1));
  push(_empty());
  push(_ln('Thank you! Visit again.'));
  push(_ln('Goods once sold will not be taken back.'));
  push(_ln('Keep fireworks away from children.'));
  push(_empty());

  // Feed & cut
  push(cmd.feed(5));
  push(cmd.cut());

  return new Uint8Array(bytes);
}

// ─── Send bytes to printer over BLE ───────────────────────────────────────────

const CHUNK_SIZE = 20;
const CHUNK_DELAY_MS = 12;

export async function printOrder(order, shopInfo = {}) {
  if (!isConnected()) throw new Error('Printer not connected');
  const bytes = buildReceiptBytes(order, shopInfo);
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.slice(i, i + CHUNK_SIZE);
    if (_char.properties.writeWithoutResponse) {
      await _char.writeValueWithoutResponse(slice);
    } else {
      await _char.writeValueWithResponse(slice);
    }
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
  }
}
