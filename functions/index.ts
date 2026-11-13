import { createHandler } from './handler.ts';

// Secret 只在 edge 运行时读取，打包产物里不含任何密钥。
Deno.serve(
  createHandler({
    DASHSCOPE_API_KEY: Deno.env.get('DASHSCOPE_API_KEY'),
    AI_MODEL: Deno.env.get('AI_MODEL'),
    AI_BASE_URL: Deno.env.get('AI_BASE_URL'),
  }),
);
