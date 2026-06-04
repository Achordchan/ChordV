import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { unlinkSync } from "node:fs";
import { tap } from "rxjs";

type UploadedTempFile = {
  path: string;
};

@Injectable()
export class UploadedTempFileCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const cleanup = () => {
      const request = context.switchToHttp().getRequest<{ file?: UploadedTempFile }>();
      const filePath = request.file?.path;
      if (filePath) {
        try {
          unlinkSync(filePath);
        } catch {
          // The upload service may have already moved or deleted the temp file.
        }
      }
    };

    return next.handle().pipe(
      tap({
        next: cleanup,
        error: cleanup
      })
    );
  }
}
