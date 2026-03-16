const ALLOWED_ORIGIN = "https://additivedex.com";
const UPSTREAM_TIMEOUT_MS = 55000; // Vercelの60秒制限より5秒短く設定

// サーバー側で注入するシステムプロンプト
// フロントのユーザープロンプトと合わせて解析精度を向上させる
const SYSTEM_PROMPT = `あなたは日本の食品表示を読み取る専門AIです。
以下のガイドラインに従って画像を解析してください：
1. 画像が斜め・暗い・ピンぼけでも「原材料名」の欄を探して読み取ってください
2. 賞味期限・保存方法・栄養成分表・アレルゲン・製造者情報などが写っていても無視し、「原材料名」欄のみを対象にしてください
3. 「原材料名」または「原材料」の文字が見当たらない場合は raw_ingredients を "__NOT_FOUND__" にしてください
4. 返答は必ず純粋なJSONのみとし、マークダウンのコードブロック（\`\`\`）や説明文・前置き・後書きは一切含めないでください`;

export default async function handler(req, res) {
  // CORSプリフライト対応
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured" });
  }

  try {
    // req.bodyがBuffer/Stream/文字列のいずれでも対応
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString("utf8"));
    } else if (typeof body === "string") {
      body = JSON.parse(body);
    }
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    // base64画像の data:...;base64, プレフィックスをサーバー側でも除去
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (
            block.type === "image" &&
            block.source?.type === "base64" &&
            typeof block.source.data === "string" &&
            block.source.data.includes(",")
          ) {
            block.source.data = block.source.data.split(",").pop();
          }
        }
      }
    }

    // システムプロンプトを注入（フロントが未設定の場合）
    if (!body.system) {
      body.system = SYSTEM_PROMPT;
    }

    // 55秒タイムアウト付きでAnthropicにリクエスト
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // AIレスポンステキストからJSONを抽出してサーバー側でパース
    // フロントエンドがdata._parsedを使えばJSON.parseエラーを回避できる
    const rawText = (data.content || []).map(c => c.text || "").join("").trim();
    let parsed = null;
    let notFound = false;

    if (rawText) {
      // マークダウンコードブロックを除去
      let cleaned = rawText.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();

      // JSON.parseを試行
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // パース失敗時: { ... } の範囲を正規表現で抽出して再試行
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            // 抽出も失敗: parsedはnullのまま
          }
        }
      }

      if (parsed) {
        // 原材料名欄が見つからなかった場合のフラグを判定
        notFound =
          parsed.raw_ingredients === "__NOT_FOUND__" ||
          !parsed.raw_ingredients ||
          parsed.raw_ingredients.trim() === "";

        if (notFound) {
          parsed.raw_ingredients = null;
          parsed.detected_additives = parsed.detected_additives || [];
          parsed.not_found = true;
        }
      }
    }

    // _parsed フィールドを追加して返す（フロントで優先的に利用可能）
    return res.status(200).json({ ...data, _parsed: parsed });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        error: "Request timeout",
        detail: "解析に時間がかかりすぎました。もう一度お試しください。",
      });
    }
    return res.status(500).json({ error: "Upstream request failed", detail: err.message });
  }
}
