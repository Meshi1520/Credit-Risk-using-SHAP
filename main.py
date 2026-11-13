
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
import logging
import pickle
from pathlib import Path
import warnings

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sklearn.compose import ColumnTransformer
from sklearn.exceptions import InconsistentVersionWarning, NotFittedError
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_curve
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "calibrated_model.pkl"
THRESHOLD_PATH = BASE_DIR / "best_threshold.pkl"
DATA_PATH = BASE_DIR / "credit_risk_dataset.csv"

FEATURE_COLUMNS = [
    "person_age",
    "person_income",
    "person_home_ownership",
    "person_emp_length",
    "loan_intent",
    "loan_grade",
    "loan_amnt",
    "loan_int_rate",
    "loan_percent_income",
    "cb_person_default_on_file",
    "cb_person_cred_hist_length",
]

NUMERIC_COLUMNS = [
    "person_age",
    "person_income",
    "person_emp_length",
    "loan_amnt",
    "loan_int_rate",
    "loan_percent_income",
    "cb_person_cred_hist_length",
]

CATEGORICAL_COLUMNS = [
    "person_home_ownership",
    "loan_intent",
    "loan_grade",
    "cb_person_default_on_file",
]

ml_model = {}
logger = logging.getLogger(__name__)


def train_default_model():
    dataset = pd.read_csv(DATA_PATH)
    model_data = dataset[FEATURE_COLUMNS + ["loan_status"]].copy()

    for column in CATEGORICAL_COLUMNS:
        model_data[column] = model_data[column].astype(str).str.upper()

    X = model_data[FEATURE_COLUMNS]
    y = model_data["loan_status"]

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "num",
                Pipeline([
                    ("imputer", SimpleImputer(strategy="median")),
                    ("scaler", StandardScaler()),
                ]),
                NUMERIC_COLUMNS,
            ),
            (
                "cat",
                Pipeline([
                    ("imputer", SimpleImputer(strategy="most_frequent")),
                    ("encoder", OneHotEncoder(handle_unknown="ignore")),
                ]),
                CATEGORICAL_COLUMNS,
            ),
        ]
    )

    model = Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("classifier", LogisticRegression(max_iter=2000, class_weight="balanced", random_state=42)),
        ]
    )

    model.fit(X, y)
    probabilities = model.predict_proba(X)[:, 1]
    fpr, tpr, thresholds = roc_curve(y, probabilities)
    best_threshold = float(thresholds[np.argmax(tpr - fpr)]) if len(thresholds) else 0.5

    joblib.dump(model, MODEL_PATH)
    joblib.dump(best_threshold, THRESHOLD_PATH)

    return model, best_threshold


def load_model():
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", InconsistentVersionWarning)
            model = joblib.load(MODEL_PATH)
            threshold = float(joblib.load(THRESHOLD_PATH))

        if not np.isfinite(threshold) or not 0 <= threshold <= 1:
            raise ValueError("Saved threshold must be between 0 and 1.")

        sample = pd.DataFrame(
            [{
                "person_age": 30,
                "person_income": 50000,
                "person_home_ownership": "RENT",
                "person_emp_length": 5.0,
                "loan_intent": "PERSONAL",
                "loan_grade": "B",
                "loan_amnt": 10000,
                "loan_int_rate": 10.0,
                "loan_percent_income": 0.2,
                "cb_person_default_on_file": "N",
                "cb_person_cred_hist_length": 5,
            }],
            columns=FEATURE_COLUMNS,
        )
        probabilities = model.predict_proba(sample)
        if probabilities.shape != (1, 2) or not np.isfinite(probabilities).all():
            raise ValueError("Saved model returned invalid prediction probabilities.")
    except (
        OSError,
        EOFError,
        pickle.UnpicklingError,
        ImportError,
        AttributeError,
        TypeError,
        ValueError,
        IndexError,
        InconsistentVersionWarning,
        NotFittedError,
    ) as error:
        logger.warning(
            "Saved model is unavailable or incompatible; retraining with the active "
            "scikit-learn version: %s",
            error,
        )
        model, threshold = train_default_model()

    ml_model["model"] = model
    ml_model["threshold"] = threshold


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield
    ml_model.clear()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def greet():
    return FileResponse(BASE_DIR / "index.html", media_type="text/html")


@app.get("/static/style.css", include_in_schema=False)
def style():
    return FileResponse(BASE_DIR / "style.css", media_type="text/css")


@app.get("/static/script.js", include_in_schema=False)
def script():
    return FileResponse(BASE_DIR / "script.js", media_type="application/javascript")


@app.get("/health")
def health():
    return {"message": "hello world"}


class LoanApplication(BaseModel):
    person_age: int
    person_income: int
    person_home_ownership: str
    person_emp_length: float
    loan_intent: str
    loan_grade: str
    loan_amnt: int
    loan_int_rate: float
    loan_percent_income: float
    cb_person_default_on_file: str
    cb_person_cred_hist_length: int


def normalize_request_data(data: LoanApplication):
    payload = data.model_dump()
    for key in ["person_home_ownership", "loan_intent", "loan_grade", "cb_person_default_on_file"]:
        if isinstance(payload.get(key), str):
            payload[key] = payload[key].upper()

    payload["person_emp_length"] = float(payload["person_emp_length"])
    return payload



@app.post("/predict")
def predict(data: LoanApplication):
    input_df = pd.DataFrame([normalize_request_data(data)], columns=FEATURE_COLUMNS)
    probability = float(ml_model["model"].predict_proba(input_df)[0, 1])
    prediction = int(probability >= ml_model["threshold"])

    return {
        "default_probability": probability,
        "default_prediction": prediction,
        "result": "high risk" if prediction == 1 else "low risk",
    }
