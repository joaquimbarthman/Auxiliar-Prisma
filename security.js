import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const jsonRateLimitHandler = (req, res) => {
  res.status(429).json({
    error: "Muitas requisicoes. Tente novamente mais tarde.",
  });
};

function limiter(options) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: jsonRateLimitHandler,
    ...options,
  });
}

export function configureSecurity(app, env = process.env) {
  const trustProxy = Number.parseInt(env.TRUST_PROXY_HOPS || "0", 10);

  if (Number.isInteger(trustProxy) && trustProxy > 0) {
    app.set("trust proxy", trustProxy);
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
}

export const globalLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 300 });
export const statusLimiter = limiter({ windowMs: 60 * 1000, limit: 60 });
export const profileViewLimiter = limiter({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 3,
});
