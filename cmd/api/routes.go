package main

import "net/http"

func (app *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/healthcheck", app.healthcheckHandler)
	mux.HandleFunc("POST /v1/consumers", app.createConsumersHandler)
	mux.HandleFunc("POST /v1/reports", app.createReportHandler)
	mux.HandleFunc("GET /v1/jobs/{id}", app.getJobHandler)
	mux.HandleFunc("POST /v1/images", app.createImageHandler)
	mux.HandleFunc("GET /v1/images/{id}/variants/{name}", app.getVariantHandler)
	mux.Handle("/", http.FileServer(http.Dir("./frontend")))
	return mux
}
