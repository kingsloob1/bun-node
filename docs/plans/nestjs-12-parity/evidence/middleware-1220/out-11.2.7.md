@nestjs/core 11.2.7, Bun 1.4.4 (6bb5dc195)
cell: middleware runs (status)

## forRoutes('*') under setGlobalPrefix('api')
| path | platform-express | BunHttpAdapter |
|---|---|---|
| `/api` | 0 (404) | 1 (404) |
| `/api/` | 1 (404) | 1 (404) |
| `/api/hello` | 1 (200) | 1 (200) |
| `/api/hello/` | 1 (200) | 1 (200) |
| `/api/nope` | 1 (404) | 1 (404) |

## the core's exact entry '/api$' alone (createMiddlewareFactory(ALL))
| path | platform-express | BunHttpAdapter |
|---|---|---|
| `/api` | 0 (404) | 1 (404) |
| `/api/` | 0 (404) | 0 (404) |
| `/api/hello` | 0 (200) | 0 (200) |

## exclude('users/login', 'invoices/{*path}').forRoutes('*')
| path | platform-express | BunHttpAdapter |
|---|---|---|
| `/api/users/login` | 0 (200) | 0 (200) |
| `/api/users/LOGIN` | 0 (200) | 0 (200) |
| `/api/users/login/` | 0 (200) | 0 (200) |
| `/api/invoices` | 1 (200) | 1 (200) |
| `/api/invoices/` | 0 (200) | 0 (200) |
| `/api/invoices/7` | 0 (200) | 0 (200) |

## the same exclude, router case-sensitive
| path | platform-express | BunHttpAdapter |
|---|---|---|
| `/api/users/login` | 0 (200) | 0 (200) |
| `/api/users/LOGIN` | 0 (404) | 0 (404) |
| `/api/users/login/` | 0 (200) | 0 (200) |

## forRoutes('*') under setGlobalPrefix('api', { exclude: ['/'] }) (overlapping paths)
| path | platform-express | BunHttpAdapter |
|---|---|---|
| `/` | 1 (404) | 1 (404) |
| `/api` | 1 (404) | 1 (404) |
| `/api/hello` | 1 (200) | 1 (200) |

