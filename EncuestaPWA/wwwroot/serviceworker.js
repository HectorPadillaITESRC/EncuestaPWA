﻿// service-worker.js



let cacheName = "encuestaCacheV1";


async function precache() {
    let cache = await caches.open(cacheName);
    await cache.add("api/encuesta");
}

self.addEventListener("install", function (e) {


    //Precache
    e.waitUntil(precache());
    createDatabase(); 
});




self.addEventListener('fetch', event => {
    if (event.request.method === "POST" && event.request.url.includes("api/encuesta")) {
        event.respondWith(networkIndexDbFallback(event.request));
    } else if (event.request.method === "GET") {
        event.respondWith(cacheFirst(event.request));
    } else {
        event.respondWith(networkFirst(event.request));
    }

});


self.addEventListener("sync", function (event) {
    if (event.tag == "enviar-respuestas") {
        event.waitUntil(enviarRespuestasGuardadas());
    }

});

async function enviarRespuestasGuardadas() {
    //recuperar todas las respuestas de la bd
    const guardadas = await getFromDatabase();

    if (guardadas.length > 0) {
        //enviarlas de una por una a la api usando fetch

        for (let resp of guardadas) {

            let response = await fetch("api/encuesta/", {
                method: "post",
                body: JSON.stringify(resp.Value),
                headers: {
                    "content-type": "application/json"
                }
            });


            if (response.ok) {
                //si se envian, borrarlas
                deleteFromDatabase(resp.Key);
            }
            else {
                break;
            }

        }





    }

    

}

async function networkIndexDbFallback(req) {

    let clon = req.clone();

    try {
        let resp = await fetch(req);
        return resp;

    } catch (e) {
        //Guardar en la bd de indexeddb el objeto y regresar una respuesta ok

        let resp =  await clon.json(); 
        addToDatabase(resp);

        //registrarme a un sync para que me avise cuando regrese la conexión
        self.registration.sync.register("enviar-respuestas");


        return new Response(null, { status: 200 });

    }
}



async function networkOnly(req) {
    try {
        let response = await fetch(req);
        if (response.ok) {
            return response;
        } else {
            return new Response("Error al obtener la respuesta de la red", { status: response.status });
        }
    } catch (error) {
        console.log(error);
        return new Response("Error al acceder a la red", { status: 500 });
    }
}


async function cacheOnly(req) {
    try {
        let cache = await caches.open(cacheName);
        let response = await cache.match(req);
        if (response) {
            return response;
        } else {
            return new Response("No se encontró en caché", { status: 404 });
        }
    } catch (x) {
        console.log(x);
        return new Response("Error al acceder al caché", { status: 500 });
    }
}

async function cacheFirst(req) {
    try {
        let cache = await caches.open(cacheName);
        let response = await cache.match(req);
        if (response) {
            return response;
        } else {
            let respuesta = await fetch(req);
            if (respuesta.ok) { // Verificar si la respuesta es válida
                cache.put(req, respuesta.clone());
            }
            return respuesta;
        }
    } catch (x) {
        console.log(x);
        return new Response("Error fetching the resource: " + req.url, { status: 500 });
    }
}

async function networkFirst(req) {
    let cache = await caches.open(cacheName);
    try {
        let respuesta = await fetch(req);
        if (respuesta.ok) {
            cache.put(req, respuesta.clone());
        }
        return respuesta;
    } catch (x) {
        let response = await cache.match(req);
        if (response) {
            return response;
        } else {
            console.log(x);
            return new Response("Recurso no disponible en caché ni en la red", { status: 503 });
        }
    }
}

async function staleWhileRevalidate(url) {
    try {
        let cache = await caches.open(cacheName);
        let response = await cache.match(url);

        let fetchPromise = fetch(url).then(async networkResponse => {
            if (networkResponse.ok) {
                await cache.put(url, networkResponse.clone());
            }
            return networkResponse;
        }).catch(err => {
            console.log("Error fetching from network:", err);
        });

        return response || fetchPromise;
    } catch (x) {
        console.log("Error en staleWhileRevalidate:", x);
        return new Response("Error interno", { status: 500 });
    }
}



let channel = new BroadcastChannel("refreshChannel")

async function staleThenRevalidate(req) {
    try {
        let cache = await caches.open(cacheName);
        let cachedResponse = await cache.match(req);

        if (cachedResponse) {
            fetch(req).then(async (networkResponse) => {
                if (networkResponse.ok) {
                    let cacheData = await cachedResponse.clone().text();
                    let networkData = await networkResponse.clone().text();

                    if (cacheData !== networkData) {
                        await cache.put(req, networkResponse.clone());
                        channel.postMessage({
                            url: req.url,
                            data: networkData
                        });
                    }
                }
            }).catch(err => {
                console.log("Error al obtener la respuesta de la red:", err);
            });

            return cachedResponse.clone();
        } else {
            return networkFirst(req);
        }
    } catch (error) {
        console.log("Error en staleThenRevalidate:", error);
        return new Response("Error interno", { status: 500 });
    }
}



let maxage = 24 * 60 * 60 * 1000;

async function timeBasedCache(req) {
    try {
        let cache = await caches.open(cacheName);
        let cachedResponse = await cache.match(req);

        if (cachedResponse) {
            let fechaDescarga = cachedResponse.headers.get("fecha");

            if (fechaDescarga) {
                let fecha = new Date(fechaDescarga);
                let hoy = new Date();
                let diferencia = hoy - fecha;

                if (diferencia <= maxage) {
                    return cachedResponse;
                }
            }
        }

        let networkResponse = await fetch(req);

        if (networkResponse.ok) {
            let nuevoResponse = new Response(networkResponse.body, {
                status: networkResponse.status,
                statusText: networkResponse.statusText,
                headers: networkResponse.headers
            });
            nuevoResponse.headers.append("fecha", new Date().toISOString());  // Añadir la fecha de la descarga
            await cache.put(req, nuevoResponse.clone());  // Guardar en el caché

            return nuevoResponse;
        } else {
            return new Response("Error en la red", { status: 502 });
        }

    } catch (error) {
        console.log("Error en timeBasedCache:", error);
        return new Response("Error interno", { status: 500 });
    }
}

async function networkCacheRace(req) {
    try {
        let cache = await caches.open(cacheName);

        let networkPromise = fetch(req).then(response => {
            if (response.ok) {
                cache.put(req, response.clone());
                return response;
            }
            throw new Error("Error en la respuesta de red");
        });

        let cachePromise = cache.match(req);

        return await Promise.race([networkPromise, cachePromise]);

    } catch (error) {
        console.log("Error en networkCacheRace:", error);
        return new Response("Error en la obtención de datos", { status: 500 });
    }
}



// Crea la BD
function createDatabase() {
    let openRequest = indexedDB.open("encuestas2", 1);

    openRequest.onupgradeneeded = function () {
        let db = openRequest.result;
        db.createObjectStore('respuestas', { autoIncrement: true });
    };

    openRequest.onerror = function () {
    };

    openRequest.onsuccess = function () {
    };
}

// Agregar un objeto a la BD
function addToDatabase(obj) {
    let openRequest = indexedDB.open("encuestas2", 1);
    openRequest.onsuccess = function () {
        let db = openRequest.result;
        let transaction = db.transaction("respuestas", "readwrite");
        let objectStore = transaction.objectStore("respuestas");
        const resultado = objectStore.add(obj);

        resultado.onsuccess = function () {
        };

        // Si hubo un error al agregar el objeto
        resultado.onerror = function () {
        };
    };


}

// Regresar todos los objetos de la BD
async function getFromDatabase() {
    return new Promise(function (resolve, reject) {
        let openRequest = indexedDB.open("encuestas2", 1);
        openRequest.onsuccess = function () {
            let db = openRequest.result;
            let transaction = db.transaction("respuestas", "readonly");
            let objectStore = transaction.objectStore("respuestas");
            let datos = objectStore.getAll();

            datos.onsuccess = function () {
                resolve(datos.result);
            };

            datos.onerror = function () {
                reject("Error al obtener datos de la BD");
            };
        };
    });
}

// Eliminar un objeto de la BD
function deleteFromDatabase(id) {
    let openRequest = indexedDB.open("encuestas2", 1);
    openRequest.onsuccess = function () {
        let db = openRequest.result;
        let transaction = db.transaction("respuestas", "readwrite");
        let objectStore = transaction.objectStore("respuestas");
        const resultado = objectStore.delete(id);

        resultado.onsuccess = function () {
            console.log("Objeto eliminado");
        };

        resultado.onerror = function () {
        };
    };

    
}
