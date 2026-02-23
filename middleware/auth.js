// Middleware para proteger rutas que requieren autenticación
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    // Si la cuenta está congelada, permitir la petición que reactivar la cuenta
    if (req.session.user && req.session.user.frozen) {
        // Allow the unfreeze POST to proceed so the user can reactivate their account
        if (req.method === 'POST' && req.path === '/support/unfreeze-account') {
            return next();
        }
        return res.redirect('/support/account-frozen');
    }
    next();
}

// Middleware para redirigir usuarios autenticados (para páginas de login/register)
function requireGuest(req, res, next) {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    next();
}

module.exports = {
    requireAuth,
    requireGuest
};
