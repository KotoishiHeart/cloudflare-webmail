import { handleWebRequest } from './app.js';

export default {
  fetch(request: Request, env: WebEnv): Promise<Response> {
    return handleWebRequest(request, env);
  },
} satisfies ExportedHandler<WebEnv>;
