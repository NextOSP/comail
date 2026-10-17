//! Decision models: typed answers (yes/no probability, one-of choice) instead
//! of generated text. Two wire dialects exist for the same idea:
//!
//! - **OpenRouter / TypeSafe** (`POST /api/alpha/decisions`, Jev and friends):
//!   `{model, state, questions: {name: {type: "noul"|"choice", ...}}}` with
//!   answers keyed by name.
//! - **OpenAI** (`POST /v1/decisions`, GPT-6 Luna): `{model, input,
//!   questions: [{type: "predicate"|"choice", name, ...}]}` with answers in
//!   question order.
//!
//! Callers build [`Question`]s once; [`decide`] speaks whichever dialect the
//! configured endpoint uses. Every failure is an error the caller can fall
//! back from (the chat classifier, then the heuristic) - routing never blocks
//! on a decision provider.

use crate::error::{CoreError, Result};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/alpha/decisions";
pub const OPENAI_URL: &str = "https://api.openai.com/v1/decisions";
pub const DEFAULT_OPENROUTER_MODEL: &str = "typesafe/jev-1.14";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-6-luna";

/// Request/response shape spoken by an endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// `state` + questions map (`noul` / `choice`), answers map.
    OpenRouter,
    /// `input` + questions array (`predicate` / `choice`), answers array.
    OpenAi,
}

impl Dialect {
    /// Settings value for the custom provider's format picker.
    pub fn from_setting(value: &str) -> Self {
        match value {
            "openai" => Dialect::OpenAi,
            _ => Dialect::OpenRouter,
        }
    }
}

pub struct DecisionConfig {
    /// "openrouter" | "openai" | "custom", for status and logs.
    pub provider: String,
    pub url: String,
    pub model: String,
    pub api_key: String,
    pub dialect: Dialect,
    /// Answers less certain than this count as "no" / "no choice".
    pub min_confidence: f64,
    pub usage_sink: Option<std::sync::Arc<dyn Fn(super::AiUsage) + Send + Sync>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Question {
    /// Yes/no judgment.
    Predicate { instructions: String },
    /// Exactly one of `options` (`(value, optional guidance)`).
    Choice {
        instructions: String,
        options: Vec<(String, Option<String>)>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// Probability the predicate holds.
    Predicate {
        probability: f64,
    },
    Choice {
        choice: String,
        confidence: f64,
    },
    /// The model declined to answer this question.
    Refusal,
}

impl Answer {
    /// Did the predicate hold with at least `min` probability?
    pub fn yes(&self, min: f64) -> bool {
        matches!(self, Answer::Predicate { probability } if *probability >= min)
    }

    /// The chosen option when confident enough.
    pub fn choice(&self, min: f64) -> Option<&str> {
        match self {
            Answer::Choice { choice, confidence } if *confidence >= min => Some(choice),
            _ => None,
        }
    }
}

/// Build the request body for `dialect`. `questions` keeps caller order.
pub fn request_body(
    dialect: Dialect,
    model: &str,
    state: &str,
    questions: &[(String, Question)],
) -> Value {
    match dialect {
        Dialect::OpenRouter => {
            let qs: serde_json::Map<String, Value> = questions
                .iter()
                .map(|(name, q)| {
                    let v = match q {
                        Question::Predicate { instructions } => json!({
                            "type": "noul",
                            "instructions": instructions,
                            "criteria": { "true": "Yes, it does.", "false": "No, it does not." },
                        }),
                        Question::Choice {
                            instructions,
                            options,
                        } => {
                            let criteria: serde_json::Map<String, Value> = options
                                .iter()
                                .map(|(value, guide)| (value.clone(), json!(guide)))
                                .collect();
                            json!({
                                "type": "choice",
                                "instructions": instructions,
                                "criteria": criteria,
                            })
                        }
                    };
                    (name.clone(), v)
                })
                .collect();
            json!({ "model": model, "state": state, "questions": qs })
        }
        Dialect::OpenAi => {
            let qs: Vec<Value> = questions
                .iter()
                .map(|(name, q)| match q {
                    Question::Predicate { instructions } => json!({
                        "type": "predicate",
                        "name": name,
                        "instructions": instructions,
                    }),
                    Question::Choice {
                        instructions,
                        options,
                    } => json!({
                        "type": "choice",
                        "name": name,
                        "instructions": instructions,
                        "choices": options
                            .iter()
                            .map(|(value, guide)| json!({
                                "value": value,
                                "description": guide.clone().unwrap_or_default(),
                            }))
                            .collect::<Vec<_>>(),
                    }),
                })
                .collect();
            json!({ "model": model, "input": state, "questions": qs })
        }
    }
}

fn parse_answer(v: &Value) -> Option<Answer> {
    let num = |key: &str| v.get(key).and_then(Value::as_f64);
    match v.get("type").and_then(Value::as_str)? {
        "noul" => num("noul")
            .or_else(|| num("probability"))
            .map(|probability| Answer::Predicate { probability }),
        "predicate" => num("probability")
            .or_else(|| num("noul"))
            .map(|probability| Answer::Predicate { probability }),
        "choice" => {
            let choice = v.get("choice").and_then(Value::as_str)?.to_string();
            // A missing confidence falls back to the chosen option's probability.
            let from_probs = || match v.get("probabilities")? {
                Value::Object(m) => m.get(&choice).and_then(Value::as_f64),
                Value::Array(a) => a.iter().find_map(|p| {
                    (p.get("value").and_then(Value::as_str) == Some(choice.as_str()))
                        .then(|| p.get("probability").and_then(Value::as_f64))
                        .flatten()
                }),
                _ => None,
            };
            let confidence = num("confidence").or_else(from_probs).unwrap_or(1.0);
            Some(Answer::Choice { choice, confidence })
        }
        "refusal" => Some(Answer::Refusal),
        _ => None,
    }
}

/// Answers keyed by question name. Unknown or malformed answers are dropped
/// (the caller treats a missing answer as "no").
pub fn parse_response(dialect: Dialect, body: &Value) -> Result<HashMap<String, Answer>> {
    let answers = body
        .get("answers")
        .ok_or_else(|| CoreError::Other("decision api: response has no answers".into()))?;
    let mut out = HashMap::new();
    match (dialect, answers) {
        (_, Value::Object(map)) => {
            for (name, v) in map {
                if let Some(a) = parse_answer(v) {
                    out.insert(name.clone(), a);
                }
            }
        }
        (_, Value::Array(list)) => {
            for v in list {
                let Some(name) = v.get("name").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(a) = parse_answer(v) {
                    out.insert(name.to_string(), a);
                }
            }
        }
        _ => {
            return Err(CoreError::Other(
                "decision api: answers is neither a map nor a list".into(),
            ));
        }
    }
    Ok(out)
}

/// Ask every question about `state` in one request.
pub async fn decide(
    cfg: &DecisionConfig,
    state: &str,
    questions: &[(String, Question)],
) -> Result<HashMap<String, Answer>> {
    if questions.is_empty() {
        return Ok(HashMap::new());
    }
    let body = request_body(cfg.dialect, &cfg.model, state, questions);
    let raw = super::http_request(
        &cfg.url,
        "POST",
        &cfg.api_key,
        Some(serde_json::to_string(&body)?),
        30,
    )
    .await
    .map_err(|e| match e {
        // Keep the provider visible in logs and the Settings test result.
        CoreError::Other(m) => CoreError::Other(m.replacen("ai api", "decision api", 1)),
        other => other,
    })?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| CoreError::Other(format!("decision api: bad json: {e}")))?;
    if let Some(sink) = &cfg.usage_sink {
        let usage = value.get("usage");
        let get = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_i64);
        let prompt = get("input_tokens");
        let completion = get("output_tokens");
        sink(super::AiUsage {
            model: cfg.model.clone(),
            prompt_tokens: prompt.unwrap_or_else(|| super::approximate_tokens(state)),
            completion_tokens: completion.unwrap_or(0),
            total_tokens: get("total_tokens")
                .unwrap_or(prompt.unwrap_or(0) + completion.unwrap_or(0)),
            exact: prompt.is_some(),
        });
    }
    parse_response(cfg.dialect, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qs() -> Vec<(String, Question)> {
        vec![
            (
                "category".into(),
                Question::Choice {
                    instructions: "Which category?".into(),
                    options: vec![
                        ("News".into(), Some("newsletters".into())),
                        ("None".into(), None),
                    ],
                },
            ),
            (
                "rule_a".into(),
                Question::Predicate {
                    instructions: "Is it an invoice?".into(),
                },
            ),
        ]
    }

    #[test]
    fn openrouter_body_uses_map_and_noul() {
        let b = request_body(Dialect::OpenRouter, "typesafe/jev-1.14", "hi", &qs());
        assert_eq!(b["model"], "typesafe/jev-1.14");
        assert_eq!(b["state"], "hi");
        assert_eq!(b["questions"]["rule_a"]["type"], "noul");
        assert!(b["questions"]["rule_a"]["criteria"]["true"].is_string());
        assert!(b["questions"]["rule_a"]["criteria"]["false"].is_string());
        assert_eq!(
            b["questions"]["category"]["criteria"]["News"],
            "newsletters"
        );
        assert!(b["questions"]["category"]["criteria"]["None"].is_null());
    }

    #[test]
    fn openai_body_uses_array_and_predicate() {
        let b = request_body(Dialect::OpenAi, "gpt-6-luna", "hi", &qs());
        assert_eq!(b["input"], "hi");
        assert_eq!(b["questions"][0]["name"], "category");
        assert_eq!(b["questions"][0]["choices"][0]["value"], "News");
        assert_eq!(b["questions"][1]["type"], "predicate");
    }

    #[test]
    fn parses_openrouter_answers() {
        let body = json!({
            "model": "typesafe/jev-1.14",
            "answers": {
                "category": {"type": "choice", "choice": "News", "confidence": 0.9,
                             "probabilities": {"News": 0.9, "None": 0.1}},
                "rule_a": {"type": "noul", "noul": 0.82},
            },
            "usage": {"input_tokens": 10, "output_tokens": 0},
        });
        let a = parse_response(Dialect::OpenRouter, &body).unwrap();
        assert_eq!(a["category"].choice(0.6), Some("News"));
        assert!(a["rule_a"].yes(0.6));
        assert!(!a["rule_a"].yes(0.9));
    }

    #[test]
    fn parses_openai_answers_and_refusals() {
        let body = json!({
            "answers": [
                {"type": "choice", "name": "category", "choice": "None",
                 "probabilities": [{"value": "None", "probability": 0.55}]},
                {"type": "predicate", "name": "rule_a", "probability": 0.2},
                {"type": "refusal", "name": "rule_b"},
            ],
        });
        let a = parse_response(Dialect::OpenAi, &body).unwrap();
        assert_eq!(a["category"].choice(0.5), Some("None"));
        assert_eq!(a["category"].choice(0.6), None);
        assert!(!a["rule_a"].yes(0.5));
        assert_eq!(a["rule_b"], Answer::Refusal);
        assert!(!a["rule_b"].yes(0.0));
    }

    #[test]
    fn missing_answers_is_an_error() {
        assert!(parse_response(Dialect::OpenRouter, &json!({"error": {}})).is_err());
    }
}
