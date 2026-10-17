async function loadMeta(id) {
  const res = await fetch(
    `https://www.dailymotion.com/player/metadata/video/${id}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Referer": "https://www.dailymotion.com/",
        "Origin": "https://www.dailymotion.com",
        "Accept": "application/json"
      }
    }
  );

  if (!res.ok) {
    throw new Error(`Metadata isteği başarısız oldu (HTTP ${res.status})`);
  }

  return await res.json();
}

/* Extract Manifest URL */
function getManifest(meta) {
  if (meta && meta.qualities && meta.qualities.auto) {
    const arr = meta.qualities.auto;
    const hls = arr.find(
      x => x.type && x.type.includes("mpegURL")
    );
    if (hls) {
      return hls.url;
    }
  }
  return null;
}

/* Proxy File (Segments / Media TS/MP4/AAC) */
async function proxyFile(fileUrl, request) {
  if (!fileUrl) {
    return new Response("URL parametresi eksik", { status: 400 });
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Referer": "https://www.dailymotion.com/",
    "Origin": "https://www.dailymotion.com"
  };

  const range = request.headers.get("range");
  if (range) {
    headers["Range"] = range;
  }

  const upstream = await fetch(fileUrl, { headers });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

/* Proxy Manifest (M3U8 rewrite) */
async function proxyManifest(manifestUrl, origin) {
  const upstream = await fetch(manifestUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Referer": "https://www.dailymotion.com/"
    }
  });

  if (!upstream.ok) {
    return new Response(`Manifest alınamadı: ${upstream.status}`, { status: upstream.status });
  }

  let text = await upstream.text();

  // URL çözümlemeyi düzgün yapmak için URL objesi kullanıyoruz
  const manifestBase = new URL(manifestUrl);

  const lines = text.split("\n");
  const rewrittenLines = lines.map(line => {
    const trimmed = line.trim();

    // Yorum satırları veya boş satırlar aynen kalır
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    // Göreceli (relative) linkleri tam URL'ye çevir
    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, manifestBase).href;
    } catch (e) {
      absoluteUrl = trimmed;
    }

    // Nested m3u8 playlist yönlendirmesi
    if (absoluteUrl.includes(".m3u8") || absoluteUrl.includes("type=m3u8")) {
      return `${origin}/proxy.m3u8?url=${encodeURIComponent(absoluteUrl)}`;
    }

    // TS / MP4 / AAC Segment yönlendirmesi
    return `${origin}/seg?u=${encodeURIComponent(absoluteUrl)}`;
  });

  return new Response(rewrittenLines.join("\n"), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    }
  });
}

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/debug") {
        return new Response("DMTV RECURSIVE V2 OK");
      }

      /* Segment Proxy */
      if (url.pathname === "/seg") {
        const file = url.searchParams.get("u");
        return await proxyFile(file, request);
      }

      /* Nested Manifest Proxy */
      if (url.pathname === "/proxy.m3u8") {
        const manifest = url.searchParams.get("url");
        return await proxyManifest(manifest, url.origin);
      }

      /* Base Request Handling */
      const path = url.pathname.replace("/", "");
      if (!path) {
        return new Response("ID Bulunamadı", { status: 400 });
      }

      const id = path.replace(".json", "").replace(".m3u8", "");

      const meta = await loadMeta(id);
      const manifest = getManifest(meta);

      if (!manifest) {
        return Response.json({ error: "Manifest bulunamadı", meta }, { status: 404 });
      }

      if (path.endsWith(".json")) {
        return Response.json({
          id,
          title: meta.title,
          manifest
        });
      }

      return await proxyManifest(manifest, url.origin);

    } catch (e) {
      return new Response(`Hata: ${e.message}`, {
        status: 500
      });
    }
  }
};
