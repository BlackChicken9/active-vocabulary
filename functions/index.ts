import { createHandler } from './handler.ts';

// Secret 只在 edge 运行时读取，打包产物里不含任何密钥。
Deno.serve(
  createHandler({
    // 站点 Secret 的名字是 API_KEY，网关内部统一叫 LLM_API_KEY，换服务商不用改 Secret。
    LLM_API_KEY: Deno.env.get('API_KEY'),
    AI_MODEL: Deno.env.get('AI_MODEL'),
    AI_BASE_URL: Deno.env.get('AI_BASE_URL'),
  }),
);
