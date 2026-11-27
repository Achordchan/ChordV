import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs";
import { SubscriptionLinkPublicationService } from "./subscription-link-publication.service";

/** Requests that only read. Anything else may have changed what a link serves. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Starts a publication pass as soon as an admin write succeeds.
 *
 * Almost every admin write can change what some link serves — a renewal, a
 * plan, a node, a team, a user's status — and following each one to the links
 * it touches would mean keeping that map by hand. A pass already works out
 * what changed and writes only that, so it is cheaper to just start one: a
 * renewal reaches the edge in seconds instead of on the next half-minute tick.
 *
 * The scheduled pass stays. Expiry happens on the clock, with no request to
 * announce it, and a write made anywhere other than the admin API is caught
 * there. kick() never throws and never delays the response; passes asked for
 * while one runs fold into one more.
 */
@Injectable()
export class SubscriptionLinkKickInterceptor implements NestInterceptor {
  // Named explicitly: the interceptor is also built where no decorator
  // metadata is emitted (the route tests run under tsx).
  constructor(@Inject(SubscriptionLinkPublicationService) private readonly publication: SubscriptionLinkPublicationService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const method = context.switchToHttp().getRequest<{ method?: string }>().method?.toUpperCase() ?? "GET";
    if (READ_METHODS.has(method)) return next.handle();
    // On completion, not on the first value: a streamed response has not
    // finished its work when it starts emitting.
    return next.handle().pipe(tap({ complete: () => this.publication.kick() }));
  }
}
