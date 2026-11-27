"use client";

export function WalletHeaderIsolationStyle() {
  return (
    <style>{`
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header,
      .wallet-page-root.page-shell > .page-header.wallet-app-header {
        background: #f7f6f0 !important;
        background-color: #f7f6f0 !important;
        background-image: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
        box-shadow: 0 5px 18px rgba(38, 39, 30, .045) !important;
        border-bottom: 1px solid rgba(135, 123, 91, .18) !important;
        isolation: isolate !important;
        z-index: 50 !important;
      }
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header::before,
      .wallet-private-bank-shell.page-shell > .page-header.wallet-app-header::after,
      .wallet-page-root.page-shell > .page-header.wallet-app-header::before,
      .wallet-page-root.page-shell > .page-header.wallet-app-header::after {
        content: none !important;
        display: none !important;
        background: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }
    `}</style>
  );
}
