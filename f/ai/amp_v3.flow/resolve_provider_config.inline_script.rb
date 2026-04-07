# Resolve provider configuration from the f/ai/amp_providers variable.
#
# Input:
#   model  — requested model name (may be empty → use default)
#
# Output (hash):
#   {
#     "provider"      => "anthropic",
#     "litellm_model" => "anthropic/claude-sonnet-4-20250514",
#     "api_key"       => "sk-ant-...",
#     "max_tokens"    => 8192
#   }

require "json"

def main(model: "")
  raw = variable_get("f/ai/amp_providers")
  config = JSON.parse(raw)

  providers = config["providers"]
  default_provider = config["default_provider"]
  default_model = config["default_model"]

  # Use defaults when model is blank
  requested_model = model.to_s.strip.empty? ? default_model : model.to_s.strip

  # Search all providers for the requested model
  matched_provider = nil
  model_config = nil

  providers.each do |name, prov|
    if prov["models"]&.key?(requested_model)
      matched_provider = name
      model_config = prov["models"][requested_model]
      break
    end
  end

  if matched_provider.nil?
    raise "Unknown model: #{requested_model}. " \
          "Available: #{providers.flat_map { |_, p| p['models']&.keys || [] }.join(', ')}"
  end

  provider_entry = providers[matched_provider]

  # Resolve the API key from a Windmill variable
  api_key = variable_get(provider_entry["api_key_variable"])

  {
    "provider"      => matched_provider,
    "litellm_model" => model_config["litellm_model"],
    "api_key"       => api_key,
    "max_tokens"    => model_config["max_tokens"]
  }
end
