import { useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Bluetooth, BluetoothConnected, BluetoothOff, Loader, Share2, MessageCircle } from "lucide-react";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { money, rupeesInWords } from "@/lib/totals";
import {
  isBTSupported,
  isConnected,
  connectPrinter,
  disconnect,
  getSavedPrinterName,
  printOrder,
} from "@/lib/btPrinter";

export default function Receipt() {
  const { id } = useParams();
  const { user } = useAuth();

  // ── BT printer state ──────────────────────────────────────────────────────
  const [btState, setBtState] = useState(() =>
    isConnected() ? "connected" : getSavedPrinterName() ? "saved" : "idle"
  );
  const [btLabel, setBtLabel] = useState(() => getSavedPrinterName() || "");
  const [btError, setBtError] = useState("");

  const handleConnect = useCallback(async () => {
    setBtError("");
    setBtState("connecting");
    try {
      const name = await connectPrinter();
      setBtLabel(name);
      setBtState("connected");
    } catch (e) {
      setBtState("idle");
      if (
        e.name === "NotFoundError" ||
        e.message?.toLowerCase().includes("cancel") ||
        e.message?.toLowerCase().includes("no device selected") ||
        e.message?.toLowerCase().includes("chose no device")
      ) {
        setBtError(
          "No printer selected. Turn ON your BTP-802 printer, make sure it is paired in your phone's Bluetooth Settings, then tap Connect Printer again."
        );
      } else if (e.name === "NotSupportedError" || e.name === "SecurityError") {
        setBtError("Bluetooth is disabled or blocked. Please enable Bluetooth on your device and allow this site to use it.");
      } else if (e.message?.includes("compatible print service")) {
        setBtError(e.message);
      } else {
        setBtError("Could not connect. Make sure the printer is ON and nearby, then try again.");
      }
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    disconnect();
    setBtLabel("");
    setBtState("idle");
    setBtError("");
  }, []);

  // ── Shop info query — must be above handleBTPrint so shopInfo is in scope ──
  const { data: shopInfo } = useQuery({
    queryKey: ["shop-info"],
    queryFn: () => api.get("/settings/public").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const handleBTPrint = useCallback(async (order) => {
    if (!isConnected()) {
      // Try to re-connect first
      setBtError("");
      setBtState("connecting");
      try {
        const name = await connectPrinter();
        setBtLabel(name);
        setBtState("connected");
      } catch (e) {
        setBtState("idle");
        if (
          e.name === "NotFoundError" ||
          e.message?.toLowerCase().includes("cancel") ||
          e.message?.toLowerCase().includes("no device selected") ||
          e.message?.toLowerCase().includes("chose no device")
        ) {
          setBtError(
            "No printer selected. Turn ON your BTP-802 printer, ensure it is paired in Bluetooth Settings, then tap Connect Printer again."
          );
        } else if (e.name === "NotSupportedError" || e.name === "SecurityError") {
          setBtError("Bluetooth is disabled or blocked. Please enable Bluetooth on your device and allow this site to use it.");
        } else {
          setBtError("Reconnect failed. Make sure the printer is ON and nearby, then try again.");
        }
        return;
      }
    }
    setBtState("printing");
    setBtError("");
    try {
      await printOrder(order, shopInfo);
      setBtState("done");
      setTimeout(() => setBtState("connected"), 3000);
    } catch (e) {
      setBtState("connected");
      setBtError("Print failed: " + (e.message || "Unknown error"));
    }
  }, [shopInfo]);
  const { data: order, isLoading, isError } = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.get(`/orders/${id}`).then((r) => r.data),
    retry: 1,
  });

  const upiId      = shopInfo?.upi_id        || "paytm.d95113099@pty";
  const upiName    = shopInfo?.upi_name      || "Balaji Fataka";
  const shopName   = shopInfo?.shop_name     || "Balaji Fataka";
  const shopAddr   = shopInfo?.address       || "";
  const shopPhone  = shopInfo?.phone         || "";
  const gstNo      = shopInfo?.gst_no        || "";
  const fireLicNo  = shopInfo?.fire_license_no || "";
  const gstEnabled = shopInfo?.gst_enabled   || false;
  const is58mm     = (shopInfo?.paper_size   || "80mm") === "58mm";
  const paperW     = is58mm ? "max-w-[240px]" : "max-w-[360px]";
  const qrSize     = is58mm ? 90 : 120;
  const printSize  = is58mm ? "58mm" : "80mm";

  // ── Share bill via WhatsApp / SMS — must be before any early return ──────────
  const [shareState, setShareState] = useState("idle"); // "idle" | "done"
  const handleShare = useCallback(async () => {
    if (!order) return;
    const dateLabel = new Date(order.created_at).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const itemLines = order.items
      .map((it) => `  • ${it.name} x${it.qty} = ₹${(it.price * it.qty).toFixed(2)}`)
      .join("\n");
    const gstLine = order.cgst > 0
      ? `\nCGST (9%): ₹${order.cgst.toFixed(2)}\nSGST (9%): ₹${order.sgst.toFixed(2)}`
      : "";
    const discountLine = order.discount > 0 ? `\nDiscount: -₹${order.discount.toFixed(2)}` : "";
    const text =
`*${shopName} — Invoice*
Inv No: *${order.invoice_no}*
Date: ${dateLabel}
Customer: ${order.customer_name}${order.customer_phone ? " | " + order.customer_phone : ""}

*Items:*
${itemLines}
${discountLine}${gstLine}
─────────────────
*Total: ₹${order.total.toFixed(2)}*
Payment: ${order.payment_mode?.toUpperCase()} | ${order.status === "paid" ? "✅ PAID" : "⏳ PENDING"}

View bill: ${window.location.href}`;

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `Invoice ${order.invoice_no}`, text, url: window.location.href });
        setShareState("done");
        setTimeout(() => setShareState("idle"), 3000);
      } catch { /* user cancelled */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    }
  }, [order, shopName]);

  if (isLoading) {
    return <div className="max-w-6xl mx-auto px-4 py-20 text-center text-mocha text-sm">Loading receipt…</div>;
  }
  if (isError || !order) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-20 text-center" data-testid="receipt-not-found">
        <div className="font-display font-bold text-2xl mb-2">Receipt not found</div>
        <Link to="/orders" data-testid="receipt-back-to-orders" className="inline-flex h-12 items-center rounded-xl bg-brick text-white font-bold text-sm px-6 mt-3">
          My orders
        </Link>
      </div>
    );
  }

  const paid = order.status === "paid";
  const dateStr = new Date(order.created_at).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 print:px-0 print:py-0" data-testid="receipt-page">
      {/* inject dynamic print page size */}
      <style>{`@media print { @page { size: ${printSize} auto; margin: 4mm; } }`}</style>
      <div className={`bg-white border border-line rounded-2xl shadow-sm p-5 mx-auto ${paperW} print:shadow-none print:border-0 print:rounded-none print:max-w-full print:p-2`} style={{ fontFamily: '"DM Sans", monospace' }} data-testid="receipt-card">
        <div className="text-center flex flex-col gap-0.5 text-[13px] leading-5">
          <div className="font-bold tracking-wide text-[15px]">{shopName}</div>
          {shopAddr && shopAddr.split("\n").map((line, i) => <div key={i}>{line}</div>)}
          {shopPhone && <div>Ph: {shopPhone}</div>}
          {gstEnabled && gstNo && <div>GSTIN: {gstNo}</div>}
          {fireLicNo && <div>Explosives Lic: {fireLicNo}</div>}
        </div>

        <div className="text-center font-bold tracking-[0.2em] text-xs my-3 border-y border-dashed border-[#1F1512] py-1.5">INVOICE</div>

        <div className="flex flex-col gap-0.5 text-[13px]">
          <div>Inv No <b>{order.invoice_no}</b></div>
          <div className="flex justify-between"><span>Date</span><span>{dateStr}</span></div>
          <div className="flex justify-between"><span>Customer</span><span>{order.customer_name} ({order.customer_type === "wholesale" ? "Wholesale" : "Retail"})</span></div>
          {order.customer_phone && <div className="flex justify-between"><span>Phone</span><span>{order.customer_phone}</span></div>}
          {order.salesperson_name && <div className="flex justify-between"><span>Salesperson</span><span>{order.salesperson_name}</span></div>}
        </div>

        <div className="flex gap-2 py-1.5 mt-2 font-bold text-[11px] uppercase border-b border-[#1F1512]">
          <div className="flex-[2]">Item</div>
          <div className="flex-1 text-right">Amount</div>
        </div>
        {order.items.map((it, i) => (
          <div key={`${it.name}-${i}`} className="py-1.5 border-b border-dashed border-[#E5D8CE] text-[13px]">
            <div className="flex justify-between gap-2">
              <span className="flex-[2]">{it.name} ({it.pack_type} of {it.pack_size})</span>
              <span className="flex-1 text-right font-bold">{(it.price * it.qty).toFixed(2)}</span>
            </div>
            <div className="text-[11px] text-mocha">{it.qty} x {it.price.toFixed(2)} · HSN {it.hsn}</div>
          </div>
        ))}

        <div className="flex justify-between text-xs text-mocha py-1.5"><span>Items {order.items.length} / Qty {order.items.reduce((s, i) => s + i.qty, 0)}</span></div>

        <div className="flex flex-col gap-0.5 text-[13px]">
          <div className="flex justify-between"><span>Subtotal</span><span>{order.subtotal.toFixed(2)}</span></div>
          {order.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>-{order.discount.toFixed(2)}</span></div>}
          {order.cgst > 0 && (
            <>
              <div className="flex justify-between" data-testid="receipt-cgst"><span>CGST (9%)</span><span>{order.cgst.toFixed(2)}</span></div>
              <div className="flex justify-between" data-testid="receipt-sgst"><span>SGST (9%)</span><span>{order.sgst.toFixed(2)}</span></div>
            </>
          )}
          {order.round_off !== 0 && <div className="flex justify-between"><span>Round off</span><span>{order.round_off.toFixed(2)}</span></div>}
        </div>

        <div className="flex justify-between items-baseline font-bold text-base border-t border-dashed border-[#1F1512] mt-2 pt-2">
          <span>TOTAL</span>
          <span data-testid="receipt-total">₹{order.total.toFixed(2)}</span>
        </div>
        <div className="text-[12px] italic mt-0.5">Rupees {rupeesInWords(order.total)} Only</div>

        <div className="border-t border-dashed border-[#1F1512] my-3" />

        <div className="flex flex-col gap-0.5 text-[13px]" data-testid="receipt-payment">
          <div className="flex justify-between"><span>Paid by {order.payment_mode === "upi" ? "UPI" : order.payment_mode === "cash" ? "Cash" : "Card"}</span><b>{order.total.toFixed(2)}</b></div>
          {order.utr && <div className="flex justify-between"><span>UTR</span><span>{order.utr}</span></div>}
          <div className="flex justify-between"><span>Status</span><b className={paid ? "text-[#1F5F36]" : "text-[#5C3F00]"} data-testid="receipt-status">{paid ? "PAID" : "PENDING"}</b></div>
        </div>

        {/* UPI QR — compact layout */}
        <div className="flex flex-col items-center gap-1 py-3 border-t border-dashed border-[#1F1512] mt-2">
          <QRCodeSVG
            value={`upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName)}&am=${order.total.toFixed(2)}&cu=INR&tn=Invoice+${encodeURIComponent(order.invoice_no)}`}
            size={qrSize}
            fgColor="#1F1512"
            data-testid="receipt-upi-qr"
          />
          <div className="text-[11px] text-mocha text-center">{upiId} · {upiName}</div>
        </div>

        <div className="border-t border-dashed border-[#1F1512]" />

        <div className="flex flex-col items-center text-center gap-0.5 pt-2 text-[13px]">
          <div className="font-bold">Thank you! Visit again.</div>
          <div>Goods once sold will not be taken back.</div>
          <div>Keep fireworks away from children.</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 justify-center mt-5 print:hidden">

        {/* ── Bluetooth print section ── */}
        {isBTSupported() && (
          <div className="w-full flex flex-col items-center gap-2">
            {/* Status bar */}
            {(btState === "connected" || btState === "printing" || btState === "done" || btState === "saving") && (
              <div className="flex items-center gap-2 text-xs font-bold text-[#1F5F36] bg-[#DDF1E3] rounded-xl px-4 py-2" data-testid="bt-connected-bar">
                <BluetoothConnected size={14} />
                <span>{btLabel || "Printer001"} connected</span>
                <button
                  onClick={handleDisconnect}
                  className="ml-2 text-mocha hover:text-brick transition-colors"
                  data-testid="bt-disconnect-btn"
                  title="Disconnect"
                >
                  <BluetoothOff size={13} />
                </button>
              </div>
            )}

            {/* Error message */}
            {btError && (
              <div className="text-xs text-brick bg-[#FFE3E3] rounded-xl px-4 py-2 max-w-xs text-center" data-testid="bt-error-msg">
                {btError}
              </div>
            )}

            {/* BT Print / Connect buttons */}
            {(btState === "connected" || btState === "done") ? (
              <button
                onClick={() => handleBTPrint(order)}
                disabled={btState === "done"}
                data-testid="bt-print-btn"
                className="h-12 px-6 rounded-xl bg-brick text-white font-bold text-sm flex items-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70"
              >
                {btState === "done" ? (
                  <><BluetoothConnected size={16} /> Printed!</>
                ) : (
                  <><Bluetooth size={16} /> Print via Bluetooth</>
                )}
              </button>
            ) : btState === "printing" ? (
              <button disabled className="h-12 px-6 rounded-xl bg-brick/70 text-white font-bold text-sm flex items-center gap-2" data-testid="bt-printing-btn">
                <Loader size={15} className="animate-spin" /> Printing…
              </button>
            ) : btState === "connecting" ? (
              <button disabled className="h-12 px-6 rounded-xl border-[1.5px] border-brick text-brick font-bold text-sm flex items-center gap-2" data-testid="bt-connecting-btn">
                <Loader size={15} className="animate-spin" /> Connecting…
              </button>
            ) : (
              <button
                onClick={handleConnect}
                data-testid="bt-connect-btn"
                className="h-12 px-6 rounded-xl border-[1.5px] border-brick text-brick font-bold text-sm flex items-center gap-2 hover:bg-brick hover:text-white transition-colors"
              >
                <Bluetooth size={16} /> Connect Printer
              </button>
            )}

            <div className="text-[11px] text-mocha text-center max-w-[260px]">
              {btState === "idle" || btState === "saved"
                ? "Turn ON your BTP-802 printer and pair it in Bluetooth Settings first, then tap Connect Printer"
                : btState === "connecting"
                ? "Select your BTP-802 printer from the device list that appears"
                : "Sends ESC/POS receipt directly to your thermal printer"}
            </div>
          </div>
        )}

        <div className="w-full border-t border-line mt-1 print:hidden" />

        {/* ── Share via WhatsApp / SMS ── */}
        <button
          onClick={handleShare}
          data-testid="share-bill-btn"
          className="h-12 px-6 rounded-xl bg-[#25D366] text-white font-bold text-sm flex items-center gap-2 hover:bg-[#1ebe5d] transition-colors"
        >
          {shareState === "done"
            ? <><Share2 size={17} /> Shared!</>
            : <><MessageCircle size={17} /> Share via WhatsApp / SMS</>}
        </button>

        {user?.role === "admin" || user?.role === "salesperson" ? (
          <>
            <Link to="/admin/pos" data-testid="receipt-new-pos-order" className="h-12 px-6 rounded-xl bg-brick text-white font-bold text-sm flex items-center">New Order</Link>
            <Link to="/admin" data-testid="receipt-admin-dashboard" className="h-12 px-6 rounded-xl border-[1.5px] border-brick text-brick font-bold text-sm flex items-center">Dashboard</Link>
          </>
        ) : (
          <>
            <Link to="/orders" data-testid="receipt-my-orders" className="h-12 px-6 rounded-xl bg-brick text-white font-bold text-sm flex items-center">My orders</Link>
            <Link to="/" data-testid="receipt-continue-shopping" className="h-12 px-6 rounded-xl border-[1.5px] border-brick text-brick font-bold text-sm flex items-center">Continue shopping</Link>
          </>
        )}
      </div>
    </div>
  );
}
