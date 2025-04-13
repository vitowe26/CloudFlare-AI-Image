// 配置
const CONFIG = {
  CF_ENV: null,
  API_KEY: "sk-xxxxx",  // 对外验证key
  SF_TOKEN:"sk-xxxxxxxxxx",
  CF_IS_TRANSLATE: true,  // 是否启用提示词AI翻译及优化,关闭后将会把提示词直接发送给绘图模型
  CF_TRANSLATE_MODEL: "@cf/qwen/qwen1.5-14b-chat-awq",  // 使用的cf ai模型
  CF_IMG2TEXT_MODEL: "@cf/llava-hf/llava-1.5-7b-hf", // 使用的cf 图生文模型
  USE_EXTERNAL_API: false, // 是否使用自定义API,开启后将使用外部模型生成提示词,需要填写下面三项
  EXTERNAL_API: "", //自定义API地址,例如:https://xxx.com/v1/chat/completions
  EXTERNAL_MODEL: "", // 模型名称,例如:gpt-4o
  EXTERNAL_API_KEY: "", // API密钥
  FLUX_NUM_STEPS: 4, // Flux模型的num_steps参数,范围：4-8
  CUSTOMER_MODEL_MAP: {
    "DS-8-CF": "@cf/lykon/dreamshaper-8-lcm",
    "SD-XL-Bash-CF": "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    "SD-XL-Lightning-CF": "@cf/bytedance/stable-diffusion-xl-lightning",
    "FLUX.1-Schnell-CF": "@cf/black-forest-labs/flux-1-schnell",
    "SF-Kolors": "Kwai-Kolors/Kolors",
    "SF-FLUX-schnell": "black-forest-labs/FLUX.1-schnell",
    "SF-SD-35large": "stabilityai/stable-diffusion-3-5-large"
  },
  IMAGE_EXPIRATION: 60 * 30 // 图片在 KV 中的过期时间（秒），这里设置为 30 分钟
};

// 主处理函数
async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  if (url.pathname.endsWith("/v1/models")) {
    return handleModelsRequest();
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
    return new Response("Not Found", { status: 404 });
  }

  return handleChatCompletions(request);
}

// 处理CORS预检请求
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

// 验证授权
function isAuthorized(request) {
  const authHeader = request.headers.get("Authorization");
  return authHeader && authHeader.startsWith("Bearer ") && authHeader.split(" ")[1] === CONFIG.API_KEY;
}

// 处理模型列表请求
function handleModelsRequest() {
  const models = Object.keys(CONFIG.CUSTOMER_MODEL_MAP).map(id => ({ id, object: "model" }));
  return new Response(JSON.stringify({ data: models, object: "list" }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}


// 新增辅助函数：解析多模态消息内容
function parseMultimodalContent(content) {
  let textParts = [];
  let base64Images = [];
  
  if (Array.isArray(content)) {
    content.forEach(item => {
      if (item.type === 'text') {
        textParts.push(item.text);
      } else if (item.type === 'image_url') {
        const url = item.image_url.url;
        if (url.startsWith('data:image')) {
          base64Images.push(url);
        }
      }
    });
  } else if (typeof content === 'string') {
    textParts.push(content);
  }

  return {
    text: textParts.join(' ').trim(),
    images: base64Images
  };
}

// 增强版getLlavaPrompt函数
async function getLlavaPrompt(imageData, textPrompt) {
  try {
    // 转换Base64为Uint8Array
    const base64String = imageData.split(',')[1];
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 构造模型输入
    const input = {
      image: [...bytes],  // 转换为普通数组
      prompt: "Describe this image in detail",
      max_tokens: 300
    };

    // 调用Cloudflare AI
    const response = await postRequestEnv(CONFIG.CF_IMG2TEXT_MODEL, input);

    // 清理响应内容
    return response.description
      .replace(/^["']+|["']+$/g, '')  // 移除首尾引号
      .replace(/\n+/g, ', ')          // 换行转逗号
      .replace(/,{2,}/g, ',')         // 清理多余逗号
      .trim();

  } catch (error) {
    console.error('LLaVA处理失败:', error);
    return textPrompt; // 失败时返回原始提示
  }
}

// 处理聊天完成请求
async function handleChatCompletions(request) {
  try {
    const data = await request.json();
    const { messages, model: requestedModel, stream } = data;
    // const userMessage = messages.find(msg => msg.role === "user")?.content; 取第一个user
    const userMessage = messages.slice().reverse().find(msg => msg.role === 'user').content; //取最后一个user

    if (!userMessage) {
      return new Response(JSON.stringify({ error: "未找到用户消息" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // 解析多模态内容
    const { text: rawText, images } = parseMultimodalContent(userMessage);
    let translatedPrompt, promptModel;
    const selectedModel = CONFIG.CUSTOMER_MODEL_MAP[requestedModel] || CONFIG.CUSTOMER_MODEL_MAP["SD-XL-Lightning-CF"];
    const isTranslate = extractTranslate(rawText);
    const cleanedText = cleanPromptString(rawText);

    // 图像优先处理逻辑
    if (images.length > 0) {
      // 使用第一张图片生成提示词
      promptModel = CONFIG.CF_IMG2TEXT_MODEL;
      const imageDescription = await getLlavaPrompt(images[0], cleanedText || "请描述这张图片");
      const translationText = isTranslate ? await getTranslationPrompt(cleanedText, promptModel) : cleanedText;
      translatedPrompt = translationText ? `${imageDescription}, ${translationText}` : imageDescription;
    } 
    else{
      // 原有文本处理流程
      promptModel = determinePromptModel();
      
      translatedPrompt = isTranslate ? 
        (selectedModel === CONFIG.CUSTOMER_MODEL_MAP["FLUX.1-Schnell-CF"] || requestedModel.startsWith("SF-") ? 
          await getFluxPrompt(cleanedText, promptModel) : 
          await getPrompt(cleanedText, promptModel)) : 
        cleanedText;
    }

    const imageUrl = selectedModel === CONFIG.CUSTOMER_MODEL_MAP["FLUX.1-Schnell-CF"] ?
      await generateAndStoreFluxImage(selectedModel, translatedPrompt, request.url) : 
      requestedModel.startsWith("SF-") ? 
      await generateAndStoreKolorsImage(selectedModel, translatedPrompt, request.url) :
      await generateAndStoreImage(selectedModel, translatedPrompt, request.url);

    return stream ? 
      handleStreamResponse(cleanedText, translatedPrompt, "1024x1024", selectedModel, imageUrl, promptModel) :
      handleNonStreamResponse(cleanedText, translatedPrompt, "1024x1024", selectedModel, imageUrl, promptModel);
  } catch (error) {
    return new Response(JSON.stringify({ error: "Internal Server Error: " + error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

function determinePromptModel() {
  return (CONFIG.USE_EXTERNAL_API && CONFIG.EXTERNAL_API && CONFIG.EXTERNAL_MODEL && CONFIG.EXTERNAL_API_KEY) ?
    CONFIG.EXTERNAL_MODEL : CONFIG.CF_TRANSLATE_MODEL;
}

async function getTranslationPrompt(prompt, model) {
  const requestBody = {
    messages: [
      {
        role: "system",
        content: `你是一个多语言翻译专家，如果下面文字包含中文，请翻译为英文并直接输出结果, 如果是其他语言一律处理为英文结果`
      },
      { role: "user", content: prompt }
    ],
    model: CONFIG.EXTERNAL_MODEL
  };

  if (model === CONFIG.EXTERNAL_MODEL) {
    return await getExternalPrompt(requestBody);
  } else {
    return await getCloudflarePrompt(CONFIG.CF_TRANSLATE_MODEL, requestBody);
  }
}

// 获取翻译后的提示词
async function getPrompt(prompt, model) {
  const requestBody = {
    messages: [
      {
        role: "system",
        content: `作为 Stable Diffusion Prompt 提示词专家，您将从关键词中创建提示，通常来自 Danbooru 等数据库。

        提示通常描述图像，使用常见词汇，按重要性排列，并用逗号分隔。避免使用"-"或"."，但可以接受空格和自然语言。避免词汇重复。

        为了强调关键词，请将其放在括号中以增加其权重。例如，"(flowers)"将'flowers'的权重增加1.1倍，而"(((flowers)))"将其增加1.331倍。使用"(flowers:1.5)"将'flowers'的权重增加1.5倍。只为重要的标签增加权重。

        提示包括三个部分：**前缀** （质量标签+风格词+效果器）+ **主题** （图像的主要焦点）+ **场景** （背景、环境）。

        *   前缀影响图像质量。像"masterpiece"、"best quality"、"4k"这样的标签可以提高图像的细节。像"illustration"、"lensflare"这样的风格词定义图像的风格。像"bestlighting"、"lensflare"、"depthoffield"这样的效果器会影响光照和深度。

        *   主题是图像的主要焦点，如角色或场景。对主题进行详细描述可以确保图像丰富而详细。增加主题的权重以增强其清晰度。对于角色，描述面部、头发、身体、服装、姿势等特征。

        *   场景描述环境。没有场景，图像的背景是平淡的，主题显得过大。某些主题本身包含场景（例如建筑物、风景）。像"花草草地"、"阳光"、"河流"这样的环境词可以丰富场景。你的任务是设计图像生成的提示。请按照以下步骤进行操作：

        1.  我会发送给您一个图像场景。需要你生成详细的图像描述
        2.  图像描述必须是英文，输出为Positive Prompt。

        示例1：

        我发送：二战时期的护士。
        您只回复：
        A WWII-era nurse in a German uniform, holding a wine bottle and stethoscope, sitting at a table in white attire, with a table in the background, masterpiece, best quality, 4k, illustration style, best lighting, depth of field, detailed character, detailed environment.
        `
      },
      { role: "user", content: prompt }
    ],
    model: CONFIG.EXTERNAL_MODEL
  };

  if (model === CONFIG.EXTERNAL_MODEL) {
    return await getExternalPrompt(requestBody);
  } else {
    return await getCloudflarePrompt(CONFIG.CF_TRANSLATE_MODEL, requestBody);
  }
}

// 获取 Flux 模型的翻译后的提示词
async function getFluxPrompt(prompt, model) {
  const requestBody = {
    messages: [
      {
        role: "system",
        content: `你是一个基于Flux.1模型的提示词生成机器人。根据用户的需求，自动生成符合Flux.1格式的绘画提示词。虽然你可以参考提供的模板来学习提示词结构和规律，但你必须具备灵活性来应对各种不同需求。最终输出应仅限提示词，无需任何其他解释或信息。你的回答必须全部使用英语进行回复我！

### **提示词生成逻辑**：

1. **需求解析**：从用户的描述中提取关键信息，包括：
   - 角色：外貌、动作、表情等。
   - 场景：环境、光线、天气等。
   - 风格：艺术风格、情感氛围、配色等。
   - 其他元素：特定物品、背景或特效。

2. **提示词结构规律**：
   - **简洁、精确且具象**：提示词需要简单、清晰地描述核心对象，并包含足够细节以引导生成出符合需求的图像。
   - **灵活多样**：参考下列模板和已有示例，但需根据具体需求生成多样化的提示词，避免固定化或过于依赖模板。
   - **符合Flux.1风格的描述**：提示词必须遵循Flux.1的要求，尽量包含艺术风格、视觉效果、情感氛围的描述，使用与Flux.1模型生成相符的关键词和描述模式。

3. **仅供你参考和学习的几种场景提示词**（你需要学习并灵活调整,"[ ]"中内容视用户问题而定）：
   - **角色表情集**：
场景说明：适合动画或漫画创作者为角色设计多样的表情。这些提示词可以生成展示同一角色在不同情绪下的表情集，涵盖快乐、悲伤、愤怒等多种情感。

提示词：An anime [SUBJECT], animated expression reference sheet, character design, reference sheet, turnaround, lofi style, soft colors, gentle natural linework, key art, range of emotions, happy sad mad scared nervous embarrassed confused neutral, hand drawn, award winning anime, fully clothed

[SUBJECT] character, animation expression reference sheet with several good animation expressions featuring the same character in each one, showing different faces from the same person in a grid pattern: happy sad mad scared nervous embarrassed confused neutral, super minimalist cartoon style flat muted kawaii pastel color palette, soft dreamy backgrounds, cute round character designs, minimalist facial features, retro-futuristic elements, kawaii style, space themes, gentle line work, slightly muted tones, simple geometric shapes, subtle gradients, oversized clothing on characters, whimsical, soft puffy art, pastels, watercolor

   - **全角度角色视图**：
场景说明：当需要从现有角色设计中生成不同角度的全身图时，如正面、侧面和背面，适用于角色设计细化或动画建模。

提示词：A character sheet of [SUBJECT] in different poses and angles, including front view, side view, and back view

   - **80 年代复古风格**：
场景说明：适合希望创造 80 年代复古风格照片效果的艺术家或设计师。这些提示词可以生成带有怀旧感的模糊宝丽来风格照片。

提示词：blurry polaroid of [a simple description of the scene], 1980s.

   - **智能手机内部展示**：
场景说明：适合需要展示智能手机等产品设计的科技博客作者或产品设计师。这些提示词帮助生成展示手机外观和屏幕内容的图像。

提示词：a iphone product image showing the iphone standing and inside the screen the image is shown

   - **双重曝光效果**：
场景说明：适合摄影师或视觉艺术家通过双重曝光技术创造深度和情感表达的艺术作品。

提示词：[Abstract style waterfalls, wildlife] inside the silhouette of a [man]’s head that is a double exposure photograph . Non-representational, colors and shapes, expression of feelings, imaginative, highly detailed

   - **高质感电影海报**：
场景说明：适合需要为电影创建引人注目海报的电影宣传或平面设计师。

提示词：A digital illustration of a movie poster titled [‘Sad Sax: Fury Toad’], [Mad Max] parody poster, featuring [a saxophone-playing toad in a post-apocalyptic desert, with a customized car made of musical instruments], in the background, [a wasteland with other musical vehicle chases], movie title in [a gritty, bold font, dusty and intense color palette].

   - **镜面自拍效果**：
场景说明：适合想要捕捉日常生活瞬间的摄影师或社交媒体用户。

提示词：Phone photo: A woman stands in front of a mirror, capturing a selfie. The image quality is grainy, with a slight blur softening the details. The lighting is dim, casting shadows that obscure her features. [The room is cluttered, with clothes strewn across the bed and an unmade blanket. Her expression is casual, full of concentration], while the old iPhone struggles to focus, giving the photo an authentic, unpolished feel. The mirror shows smudges and fingerprints, adding to the raw, everyday atmosphere of the scene.

   - **像素艺术创作**：
场景说明：适合像素艺术爱好者或复古游戏开发者创造或复刻经典像素风格图像。

提示词：[Anything you want] pixel art style, pixels, pixel art

   - **以上部分场景仅供你学习，一定要学会灵活变通，以适应任何绘画需求**：

4. **Flux.1提示词要点总结**：
   - **简洁精准的主体描述**：明确图像中核心对象的身份或场景。
   - **风格和情感氛围的具体描述**：确保提示词包含艺术风格、光线、配色、以及图像的氛围等信息。
   - **动态与细节的补充**：提示词可包括场景中的动作、情绪、或光影效果等重要细节。
   - **其他更多规律请自己寻找**
---

**问答案例1**：
**用户输入**：一个80年代复古风格的照片。
**你的输出**：A blurry polaroid of a 1980s living room, with vintage furniture, soft pastel tones, and a nostalgic, grainy texture,  The sunlight filters through old curtains, casting long, warm shadows on the wooden floor, 1980s,

**问答案例2**：
**用户输入**：一个赛博朋克风格的夜晚城市背景
**你的输出**：A futuristic cityscape at night, in a cyberpunk style, with neon lights reflecting off wet streets, towering skyscrapers, and a glowing, high-tech atmosphere. Dark shadows contrast with vibrant neon signs, creating a dramatic, dystopian mood
`
      },
      { role: "user", content: prompt }
    ],
    model: CONFIG.EXTERNAL_MODEL
  };

  if (model === CONFIG.EXTERNAL_MODEL) {
    return await getExternalPrompt(requestBody);
  } else {
    return await getCloudflarePrompt(CONFIG.CF_TRANSLATE_MODEL, requestBody);
  }
}

// 从外部API获取提示词
async function getExternalPrompt(requestBody) {
  try {
    const response = await fetch(CONFIG.EXTERNAL_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.EXTERNAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`External API request failed with status ${response.status}`);
    }

    const jsonResponse = await response.json();
    if (!jsonResponse.choices || jsonResponse.choices.length === 0 || !jsonResponse.choices[0].message) {
      throw new Error('Invalid response format from external API');
    }

    return jsonResponse.choices[0].message.content;
  } catch (error) {
    console.error('Error in getExternalPrompt:', error);
 // 如果外部API失败，回退到使用原始提示词
    return requestBody.messages[1].content;
  }
}

// 从Cloudflare获取提示词
async function getCloudflarePrompt(model, requestBody) {
  const response = await postRequestEnv(model, requestBody);

  return response.response;
}

// 返回 ArrayBuffer
async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
  }
  return result.buffer; 
}

// 生成图像并存储到 KV
async function generateAndStoreImage(model, prompt, requestUrl) {
  try {
    const jsonBody = { prompt, num_steps: 20, guidance: 7.5, strength: 1, width: 1024, height: 1024 };
    const response = await postRequestEnv(model, jsonBody);
    const imageBuffer = await streamToArrayBuffer(response);

    const key = `image_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    await CONFIG.CF_ENV.IMAGE_KV.put(key, imageBuffer, {
      expirationTtl: CONFIG.IMAGE_EXPIRATION,
      metadata: { contentType: 'image/png' }
    });

    return `${new URL(requestUrl).origin}/image/${key}`;
  } catch (error) {
    throw new Error("图像生成失败: " + error.message);
  }
}

// 使用 Flux 模型生成并存储图像
async function generateAndStoreFluxImage(model, prompt, requestUrl) {
  try {
    const jsonBody = { prompt, num_steps: CONFIG.FLUX_NUM_STEPS };
    const response = await postRequestEnv(model, jsonBody);
    const base64ImageData = response.image;

    const imageBuffer = base64ToArrayBuffer(base64ImageData);

    const key = `image_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await CONFIG.CF_ENV.IMAGE_KV.put(key, imageBuffer, {
      expirationTtl: CONFIG.IMAGE_EXPIRATION,
      metadata: { contentType: 'image/png' }
    });

    return `${new URL(requestUrl).origin}/image/${key}`;
  } catch (error) {
    throw new Error("Flux图像生成失败: " + error.message);
  }
}

// 使用 Kolors 模型生成并存储图像
async function generateAndStoreKolorsImage(model, prompt, requestUrl) {
  try {
    const response = await postSfRequest(model, prompt, 1024, 1024);
    const imageBuffer = await streamToArrayBuffer(response);

    const key = `image_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    await CONFIG.CF_ENV.IMAGE_KV.put(key, imageBuffer, {
      expirationTtl: CONFIG.IMAGE_EXPIRATION,
      metadata: { contentType: 'image/png' }
    });

    return `${new URL(requestUrl).origin}/image/${key}`;
  } catch (error) {
    throw new Error("Kolors图像生成失败: " + error.message);
  }
}

// 处理流式响应
function handleStreamResponse(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  const content = generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ delta: { content: content }, index: 0, finish_reason: null }]
      })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      'Access-Control-Allow-Origin': '*',
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// 处理非流式响应
function handleNonStreamResponse(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  const content = generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel);
  const response = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: translatedPrompt.length,
      completion_tokens: content.length,
      total_tokens: translatedPrompt.length + content.length
    }
  };

  return new Response(JSON.stringify(response), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 生成响应内容
function generateResponseContent(originalPrompt, translatedPrompt, size, model, imageUrl, promptModel) {
  return `🎨 原始提示词：${originalPrompt}\n` +
         `💬 提示词生成模型：${promptModel}\n` +
         `🌐 翻译后的提示词：${translatedPrompt}\n` +
         `📐 图像规格：${size}\n` +
         `🖼️ 绘图模型：${model}\n` +
         `🌟 图像生成成功！\n` +
         `以下是结果：\n\n` +
         `![生成的图像](${imageUrl})`;
}


// 调用ai env
async function postRequestEnv(model, jsonBody) {
  const response = await CONFIG.CF_ENV.AI.run(model, jsonBody);

  return response;
}

// 发送POST请求
async function postSfRequest(model, prompt, height, width) {

  const options = {
    method: 'POST',
    headers: {Authorization: 'Bearer '+CONFIG.SF_TOKEN, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: model,
      prompt: prompt,
      image_size: `${width}x${height}`,
      batch_size: 1,
      num_inference_steps: 20,
      guidance_scale: 7.5
    })
  };

  const apiUrl = `https://api.siliconflow.cn/v1/images/generations`;
  const response = await fetch(apiUrl, options);
  const result = await response.json();
 
  const imageUrl = result.data[0].url;
  // 获取图像数据并转为流
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image from URL: ${imageUrl}`);
  }
 
  return imageResponse.body;
}

// 提取翻译标志
function extractTranslate(prompt) {
  const match = prompt.match(/---n?tl/);
  return match ? match[0] === "---tl" : CONFIG.CF_IS_TRANSLATE;
  // return CONFIG.CF_IS_TRANSLATE;
}

// 清理提示词字符串
function cleanPromptString(prompt) {
  return prompt.replace(/---n?tl/, "").trim();
}

// 处理图片请求
async function handleImageRequest(request) {
  const url = new URL(request.url);
  const key = url.pathname.split('/').pop();
  
  const imageData = await CONFIG.CF_ENV.IMAGE_KV.get(key, 'arrayBuffer');
  if (!imageData) {
    return new Response('Image not found', { status: 404 });
  }

  return new Response(imageData, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
    },
  });
}

// base64 字符串转换为 ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export default {
  async fetch(request, env) {
    CONFIG.CF_ENV=env;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/image/')) {
      return handleImageRequest(request);
    } else {
      return handleRequest(request);
    }
  },
};
