import { handleWebRequest } from './app.js';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleWebRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
