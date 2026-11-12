import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { ChatReasoningVisibilityController } from "@/components/chat-reasoning-visibility-controller";
import { CSSImportEnhancer } from "@/components/css-import-enhancer";
import { PWAManifestInjector } from "@/components/pwa-manifest-injector";
import { PWARegistrar } from "@/components/pwa-registrar";
import { DeviceCompatibilityBootstrap } from "@/components/device-compatibility-bootstrap";
import { GlobalNoticeHost } from "@/components/ui/global-notice-host";
import "../styles/fonts.css";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Android 键盘弹出时让浏览器原生压缩布局视口（而非只压缩 visualViewport）。
  // 配合 desktop-shell 的 --phone-screen-height 同步：输入栏天然贴在键盘上方，
  // 点击命中区域由原生布局保证，彻底避免手动抬升带来的视觉/hit-test 错位。
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "float",
  description: "float",
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* 首屏设备识别：水合前识别触屏手机/平板，修正部分浏览器「桌面版网站」报告过宽视口的问题。
            手动兼容参数优先；自动缩放与水合后的 device-compatibility 规则保持一致。 */}
        <script dangerouslySetInnerHTML={{__html:`(function(){try{
          var root=document.documentElement,nav=navigator,scr=window.screen||{};
          var sw=Math.max(1,Number(scr.width)||window.innerWidth||1),sh=Math.max(1,Number(scr.height)||window.innerHeight||1);
          var shortSide=Math.min(sw,sh),coarse=false,ua=String(nav.userAgent||"");
          try{coarse=window.matchMedia("(hover: none) and (pointer: coarse)").matches;}catch(e){}
          var mobileUA=/Android|iPhone|iPad|iPod/i.test(ua)||(/Macintosh/i.test(ua)&&(Number(nav.maxTouchPoints)||0)>1);
          var touch=coarse||((Number(nav.maxTouchPoints)||0)>0&&mobileUA);
          var isPhone=touch&&shortSide>0&&shortSide<=620,isTablet=touch&&shortSide>620;
          root.setAttribute("data-device-class",isPhone?"phone":isTablet?"tablet":"desktop");
          if(isPhone){
            var viewport=document.querySelector('meta[name="viewport"]'),currentWidth=window.innerWidth||0,mobileQuery=false;
            try{mobileQuery=window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)").matches;}catch(e){}
            if(currentWidth>sw*1.25){
              if(!viewport){viewport=document.createElement("meta");viewport.name="viewport";document.head.appendChild(viewport);}
              viewport.content="width="+Math.round(sw)+", initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";
            }
            if(!mobileQuery)root.setAttribute("data-force-mobile","1");
          }
          var saved=null;try{saved=JSON.parse(localStorage.getItem("float.device-compatibility.v1")||"null");}catch(e){}
          if(!saved||saved.layoutMode!=="manual"){
            var vw=Math.max(1,(window.visualViewport&&window.visualViewport.width)||window.innerWidth||sw);
            var vh=Math.max(1,(window.visualViewport&&window.visualViewport.height)||window.innerHeight||sh);
            var autoScale=isTablet?Math.min(vw/390,vh/844):1;if(!isFinite(autoScale)||autoScale<1.001)autoScale=1;
            var userScale=Number(saved&&saved.uiScale)||1;userScale=Math.min(1.25,Math.max(.75,userScale));
            var scale=Math.min(3,Math.max(.5,autoScale*userScale));
            if(Math.abs(scale-1)>.001){
              root.style.setProperty("--phone-screen-width",Math.round(vw/scale)+"px");
              root.style.setProperty("--phone-screen-height",Math.round(vh/scale)+"px");
              root.style.setProperty("--compat-layout-scale",String(scale));
            }
          }
        }catch(e){}})();`}} />
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <meta name="theme-color" content="#f8f7f2" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/icon-192.png" type="image/png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="float" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PWAManifestInjector />
        <PWARegistrar />
        <DeviceCompatibilityBootstrap />
        <CSSImportEnhancer />
        <ChatPluginBootstrap />
        <ChatReasoningVisibilityController />
        <GlobalNoticeHost />
        {children}
      </body>
    </html>
  );
}
